"""process_stripe_event (D7.3, #40): one locked run per pending row, retried, then failed.

The task runs on real commits, like the worker: the row lock and the handler's transaction are
the point of these tests.
"""

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import pytest
from arq import Retry
from sqlalchemy import URL, delete, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import Settings
from app.modules.webhooks import handlers
from app.modules.webhooks.handlers import StripeEvent
from app.modules.webhooks.models import WebhookEvent, WebhookEventStatus
from app.modules.webhooks.tasks import process_stripe_event
from tests.conftest import make_settings

HANDLED = "test.handled"
SENTINEL = f"SENTINEL-{uuid.uuid4().hex}"


@dataclass
class RecordingHandler:
    """Records each event and the transaction it ran in; `failure` makes it raise after writing
    to the event's own row, so a rollback of its writes shows."""

    calls: list[StripeEvent] = field(default_factory=list)
    transactions: list[int] = field(default_factory=list)
    failure: Exception | None = None

    async def __call__(self, session: AsyncSession, event: StripeEvent) -> None:
        self.calls.append(event)
        txid = await session.scalar(text("SELECT txid_current()"))
        assert isinstance(txid, int)
        self.transactions.append(txid)
        if self.failure is not None:
            await session.execute(
                update(WebhookEvent)
                .where(WebhookEvent.stripe_event_id == event.stripe_event_id)
                .values(event_type="written.by.handler")
            )
            raise self.failure


@pytest.fixture
def handler(monkeypatch: pytest.MonkeyPatch) -> RecordingHandler:
    recording = RecordingHandler()
    monkeypatch.setitem(handlers.HANDLERS, HANDLED, recording)
    return recording


@pytest.fixture
def settings() -> Settings:
    return make_settings()


@dataclass
class Rows:
    sessions: async_sessionmaker[AsyncSession]
    ids: list[uuid.UUID]

    async def add(
        self,
        *,
        event_type: str = HANDLED,
        status: WebhookEventStatus = WebhookEventStatus.PENDING,
        attempts: int = 0,
    ) -> WebhookEvent:
        event_id = f"evt_test_{uuid.uuid4().hex}"
        row = WebhookEvent(
            stripe_event_id=event_id,
            event_type=event_type,
            livemode=False,
            stripe_created_at=datetime(2026, 10, 30, tzinfo=UTC),
            status=status,
            attempts=attempts,
            payload={"id": event_id, "type": event_type, "data": {"note": SENTINEL}},
        )
        async with self.sessions() as session:
            session.add(row)
            await session.commit()
        self.ids.append(row.id)
        return row

    async def get(self, row_id: uuid.UUID) -> WebhookEvent:
        async with self.sessions() as session:
            row = await session.get(WebhookEvent, row_id)
        assert row is not None
        return row

    async def xmin(self, row_id: uuid.UUID) -> int:
        """The transaction that last wrote the row (32-bit, like txid_current() mod 2^32)."""
        async with self.sessions() as session:
            value = await session.scalar(
                text("SELECT xmin::text::bigint FROM webhook_events WHERE id = :id"),
                {"id": row_id},
            )
        assert isinstance(value, int)
        return value


@pytest.fixture
async def rows(test_database_url: URL) -> AsyncIterator[Rows]:
    engine = create_async_engine(test_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    ids: list[uuid.UUID] = []
    try:
        yield Rows(sessions, ids)
    finally:
        async with sessions() as session:
            await session.execute(delete(WebhookEvent).where(WebhookEvent.id.in_(ids)))
            await session.commit()
        await engine.dispose()


def context(rows: Rows, settings: Settings, job_try: int = 1) -> dict[str, Any]:
    return {"settings": settings, "session_factory": rows.sessions, "job_try": job_try}


async def test_task_processes_once_and_clears_payload(
    rows: Rows, settings: Settings, handler: RecordingHandler
) -> None:
    row = await rows.add()

    assert await process_stripe_event(context(rows, settings), str(row.id)) == "processed"

    [event] = handler.calls
    assert event.stripe_event_id == row.stripe_event_id
    assert event.event_type == HANDLED
    assert event.livemode is False
    assert event.created == row.stripe_created_at
    assert event.payload == row.payload
    done = await rows.get(row.id)
    assert done.status is WebhookEventStatus.PROCESSED
    assert done.processed_at is not None
    assert done.payload is None
    assert done.attempts == 1
    assert done.last_error is None
    # Marked processed in the handler's own transaction.
    assert await rows.xmin(row.id) == handler.transactions[0] % 2**32

    # Run again (a duplicate job): the row is no longer pending.
    assert await process_stripe_event(context(rows, settings), str(row.id)) == "skipped"
    assert len(handler.calls) == 1


@pytest.mark.parametrize(
    "status",
    [WebhookEventStatus.PROCESSED, WebhookEventStatus.IGNORED, WebhookEventStatus.FAILED],
)
async def test_task_skips_non_pending_row(
    rows: Rows, settings: Settings, handler: RecordingHandler, status: WebhookEventStatus
) -> None:
    row = await rows.add(status=status, attempts=2)

    assert await process_stripe_event(context(rows, settings), str(row.id)) == "skipped"

    assert handler.calls == []
    after = await rows.get(row.id)
    assert (after.status, after.attempts, after.payload) == (status, 2, row.payload)


async def test_handler_error_retries_then_fails_after_max_attempts(
    rows: Rows, settings: Settings, handler: RecordingHandler, caplog: pytest.LogCaptureFixture
) -> None:
    handler.failure = ValueError(SENTINEL)
    row = await rows.add()
    max_attempts = settings.stripe_webhook_max_attempts
    backoff = settings.stripe_webhook_retry_backoff_seconds

    with caplog.at_level(logging.DEBUG):
        for attempt in range(1, max_attempts):
            with pytest.raises(Retry) as retry:
                await process_stripe_event(context(rows, settings, attempt), str(row.id))
            # A growing delay: the backoff times the attempts (ARQ keeps it in milliseconds).
            assert retry.value.defer_score == backoff * attempt * 1000
            pending = await rows.get(row.id)
            assert pending.status is WebhookEventStatus.PENDING
            assert pending.attempts == attempt
            assert pending.last_error == "ValueError"
            assert pending.payload == row.payload
            # The handler's own write was rolled back.
            assert pending.event_type == HANDLED

        outcome = await process_stripe_event(context(rows, settings, max_attempts), str(row.id))

    assert outcome == "failed"
    failed = await rows.get(row.id)
    assert failed.status is WebhookEventStatus.FAILED
    assert failed.attempts == max_attempts
    assert failed.last_error == "ValueError"
    assert failed.processed_at is None
    # Kept for a reprocess (runbook D20.4).
    assert failed.payload == row.payload
    assert len(handler.calls) == max_attempts
    [error] = [r for r in caplog.records if r.getMessage() == "stripe_webhook_failed"]
    assert error.levelno == logging.ERROR
    assert getattr(error, "stripe_event_id", None) == row.stripe_event_id
    assert getattr(error, "event_type", None) == HANDLED
    assert getattr(error, "webhook_event_id", None) == str(row.id)
    assert getattr(error, "attempts", None) == max_attempts
    for record in caplog.records:
        assert SENTINEL not in json.dumps(vars(record), default=str), record.getMessage()
    # Failed is final: another run leaves it alone.
    assert await process_stripe_event(context(rows, settings), str(row.id)) == "skipped"


async def test_last_arq_try_fails_the_row_whatever_its_attempts(
    rows: Rows, settings: Settings, handler: RecordingHandler
) -> None:
    """ARQ refuses a run past STRIPE_WEBHOOK_MAX_ATTEMPTS: its last run never asks for another."""
    handler.failure = RuntimeError("boom")
    row = await rows.add()
    last = settings.stripe_webhook_max_attempts

    assert await process_stripe_event(context(rows, settings, last), str(row.id)) == "failed"

    failed = await rows.get(row.id)
    assert (failed.status, failed.attempts) == (WebhookEventStatus.FAILED, 1)


async def test_task_ignores_type_without_handler(
    rows: Rows, settings: Settings, handler: RecordingHandler
) -> None:
    row = await rows.add(event_type="test.handler_removed", attempts=1)

    assert await process_stripe_event(context(rows, settings), str(row.id)) == "ignored"

    after = await rows.get(row.id)
    assert after.status is WebhookEventStatus.IGNORED
    assert after.payload is None
    assert after.processed_at is not None
    assert after.attempts == 1
    assert handler.calls == []


async def test_missing_row_is_reported(rows: Rows, settings: Settings) -> None:
    assert await process_stripe_event(context(rows, settings), str(uuid.uuid4())) == "missing"


def _failing_sessions() -> Callable[[], AsyncSession]:
    def factory() -> AsyncSession:
        raise OSError(SENTINEL)

    return factory


async def test_database_failure_retries_then_gives_up(
    rows: Rows, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    row_id = str(uuid.uuid4())
    ctx = {"settings": settings, "session_factory": _failing_sessions(), "job_try": 2}
    backoff = settings.stripe_webhook_retry_backoff_seconds

    with caplog.at_level(logging.WARNING), pytest.raises(Retry) as retry:
        await process_stripe_event(ctx, row_id)
    assert retry.value.defer_score == backoff * 2 * 1000

    ctx["job_try"] = settings.stripe_webhook_max_attempts
    with caplog.at_level(logging.WARNING):
        assert await process_stripe_event(ctx, row_id) == "unsettled"

    [error] = [r for r in caplog.records if r.getMessage() == "stripe_webhook_unsettled"]
    assert getattr(error, "webhook_event_id", None) == row_id
    for record in caplog.records:
        assert SENTINEL not in json.dumps(vars(record), default=str)


async def test_concurrent_runs_handle_the_event_once(
    rows: Rows, settings: Settings, handler: RecordingHandler
) -> None:
    """Two jobs for one row (a re-enqueue after a finished job): the lock makes them take turns,
    and the second finds the row processed."""
    row = await rows.add()

    outcomes = await asyncio.gather(
        process_stripe_event(context(rows, settings), str(row.id)),
        process_stripe_event(context(rows, settings), str(row.id)),
    )

    assert sorted(outcomes) == ["processed", "skipped"]
    assert len(handler.calls) == 1


def test_no_handler_is_registered_yet() -> None:
    """Part 1 registers none: account.updated is #280, payment_intent.* is #61."""
    assert handlers.HANDLERS == {}
