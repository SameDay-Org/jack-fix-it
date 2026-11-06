"""The payment reconciliation's transaction (#61; D11.5 tests): concurrent events on real
sessions, and handlers that never commit, so the worker's transaction (#40) owns every write."""

import asyncio
import json
from datetime import UTC, datetime

import pytest
from sqlalchemy import text

from app.modules.payments.models import PaymentStatus
from app.modules.quotes.models import QuoteStatus
from app.modules.quotes.service import QuoteSettlement
from app.modules.requests.models import RequestStatus
from app.modules.webhooks import handlers
from app.modules.webhooks.handlers import StripeEvent
from app.modules.webhooks.models import WebhookEventStatus
from tests.conftest import LOCK_WAIT_DEADLINE_SECONDS, backend_pid
from tests.test_payment_webhooks import (
    CANCELED,
    FAILED,
    MAX_ATTEMPTS,
    PROCESSING,
    SUCCEEDED,
    Market,
    market,
    settings,
)

__all__ = ["market", "settings"]  # fixtures, used by name


async def _waiting_behind(market: Market, holder: int) -> int:
    """How many backends wait on the `holder` backend, directly or behind another waiter (a
    second waiter on a row queues behind the first)."""
    query = text(
        "SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity "
        "WHERE cardinality(pg_blocking_pids(pid)) > 0"
    )
    async with market.sessions() as monitor:
        rows = (await monitor.execute(query)).all()
    behind = {holder}
    grew = True
    while grew:
        grew = False
        for pid, blockers in rows:
            if pid not in behind and behind & set(blockers):
                behind.add(pid)
                grew = True
    return len(behind) - 1


async def _wait_until_blocked_by(market: Market, holder: int, count: int) -> None:
    """Returns once `count` backends wait on the `holder` backend's lock."""
    try:
        async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
            while await _waiting_behind(market, holder) < count:
                pass
    except TimeoutError:
        pytest.fail(f"{count} runs did not wait on the lock within {LOCK_WAIT_DEADLINE_SECONDS} s")


async def test_concurrent_succeeded_events_create_one_job(market: Market) -> None:
    """Two succeeded events for one PaymentIntent (two event ids, so two rows and two runs), on
    two sessions. The request's row is held locked until Postgres reports both runs waiting on
    it, so they really overlap; then one creates the job and the other finds the payment
    succeeded."""
    first, second = market.new_event_id(), market.new_event_id()
    for event_id in (first, second):
        await market.post(market.body(event_id, SUCCEEDED))

    async with market.sessions() as holder:
        await holder.execute(
            text("SELECT id FROM service_requests WHERE id = :id FOR UPDATE"),
            {"id": market.request_id},
        )
        runs = asyncio.gather(market.process(first), market.process(second))
        await _wait_until_blocked_by(market, await backend_pid(holder), 2)
        await holder.commit()
        outcomes = await runs

    assert outcomes == ["processed", "processed"]
    state = await market.state()
    assert state.payment is PaymentStatus.SUCCEEDED
    assert len(state.jobs) == 1
    assert len(state.job_events) == 1
    assert state.quotes == [QuoteStatus.ACCEPTED, QuoteStatus.REJECTED, QuoteStatus.REJECTED]


@pytest.mark.parametrize("event_type", [SUCCEEDED, PROCESSING, FAILED, CANCELED])
async def test_handlers_never_commit(market: Market, event_type: str) -> None:
    """The handler runs in an open transaction; another connection sees none of its writes
    until that transaction commits, and a rollback leaves nothing."""
    handler = handlers.HANDLERS[event_type]
    event_id = market.new_event_id()
    event = StripeEvent(
        stripe_event_id=event_id,
        event_type=event_type,
        livemode=False,
        created=datetime.now(UTC),
        payload=json.loads(market.body(event_id, event_type)),
    )
    before = await market.state()

    async with market.sessions() as session:
        await handler(session, event)
        assert session.in_transaction()
        # Seen from another connection: nothing yet.
        assert await market.state() == before
        await session.rollback()

    assert await market.state() == before


@pytest.mark.parametrize(
    ("event_type", "failing"),
    [(SUCCEEDED, "reject_others"), (CANCELED, "has_live")],
    ids=["succeeded", "canceled"],
)
async def test_handler_error_rolls_back_the_job_and_quote_changes(
    market: Market, monkeypatch: pytest.MonkeyPatch, event_type: str, failing: str
) -> None:
    """The step that fails comes after the job's insert (succeeded) or after the quote's
    un-acceptance and the request's move (canceled): the savepoint takes all of it back, the
    payment included, and the event records the failure."""

    async def fail(*args: object) -> None:
        raise RuntimeError("injected")

    monkeypatch.setattr(QuoteSettlement, failing, fail)
    before = await market.state()
    event_id = market.new_event_id()
    await market.post(market.body(event_id, event_type))

    assert await market.process(event_id, job_try=MAX_ATTEMPTS) == "failed"

    after = await market.state()
    assert after == before
    assert after.payment is PaymentStatus.REQUIRES_PAYMENT
    assert after.request is RequestStatus.ACCEPTED
    assert after.jobs == []
    row = await market.event_row(event_id)
    assert (row.status, row.attempts, row.last_error) == (
        WebhookEventStatus.FAILED,
        1,
        "RuntimeError",
    )
