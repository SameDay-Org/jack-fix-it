"""POST /v1/webhooks/stripe (D7.3, #40): verified, recorded once, queued after the commit.

Requests run on real commits (each request its own session, like production), so the queue can
check that the row it is handed is already visible to another connection. Signatures are real
HMAC-SHA256 over the body with a fixture secret, verified by the Stripe SDK.
"""

import asyncio
import hashlib
import hmac
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx
import pytest
from fastapi import FastAPI
from redis.exceptions import RedisError
from sqlalchemy import URL, delete, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from starlette.requests import Request

from app.config import Settings
from app.modules.webhooks import handlers
from app.modules.webhooks.handlers import StripeEvent
from app.modules.webhooks.models import WebhookEvent, WebhookEventStatus
from app.modules.webhooks.repository import WebhookEventRepository
from app.queue import JobQueue, get_job_queue
from tests.conftest import LOCK_WAIT_DEADLINE_SECONDS, backend_pid, make_settings

# Fixture value, not a real secret.
SECRET = "whsec_test_fixture_value_not_real"
HANDLED = "test.handled"
UNHANDLED = "test.unhandled"
CREATED = 1_761_000_000
MAX_BODY = 524_288


@dataclass
class RecordingQueue:
    """ARQ's enqueue_job, recorded: a known job id is not queued again. `failure` makes every
    call raise it; `hang` makes every call wait for ever (the caller's deadline must end it).
    `committed` notes, per call, the status another connection saw for the row it was handed."""

    sessions: async_sessionmaker[AsyncSession]
    jobs: dict[str, tuple[str, tuple[object, ...]]] = field(default_factory=dict)
    calls: int = 0
    committed: list[str | None] = field(default_factory=list)
    failure: Exception | None = None
    hang: bool = False

    async def enqueue_job(self, function: str, *args: object, _job_id: str | None = None) -> object:
        self.calls += 1
        async with self.sessions() as session:
            status = await session.scalar(
                select(WebhookEvent.status).where(WebhookEvent.id == uuid.UUID(str(args[0])))
            )
        self.committed.append(None if status is None else str(status))
        if self.failure is not None:
            raise self.failure
        if self.hang:
            await asyncio.Event().wait()
        assert _job_id is not None
        if _job_id in self.jobs:
            return None
        self.jobs[_job_id] = (function, args)
        return object()


def _webhook_queue(request: Request) -> JobQueue:
    """One override for every test (a closure per test would be kept by FastAPI's cache, #196)."""
    queue: JobQueue = request.app.state.webhook_queue
    return queue


@dataclass
class Webhook:
    app: FastAPI
    client: httpx.AsyncClient
    sessions: async_sessionmaker[AsyncSession]
    queue: RecordingQueue
    event_ids: list[str]

    def new_id(self) -> str:
        event_id = f"evt_test_{uuid.uuid4().hex}"
        self.event_ids.append(event_id)
        return event_id

    async def post(
        self, body: bytes, signature: str | None = None, *, sign_it: bool = True
    ) -> httpx.Response:
        headers = {b"Content-Type": b"application/json"}
        if signature is None and sign_it:
            signature = sign(body)
        if signature is not None:
            # Bytes: httpx wants ASCII in a str header, and a client may send any byte.
            headers[b"Stripe-Signature"] = signature.encode("latin-1")
        return await self.client.post("/v1/webhooks/stripe", content=body, headers=headers)

    async def rows(self, event_id: str) -> list[WebhookEvent]:
        async with self.sessions() as session:
            statement = select(WebhookEvent).where(WebhookEvent.stripe_event_id == event_id)
            return list((await session.scalars(statement)).all())

    async def set_status(self, event_id: str, status: WebhookEventStatus) -> None:
        async with self.sessions() as session:
            await session.execute(
                update(WebhookEvent)
                .where(WebhookEvent.stripe_event_id == event_id)
                .values(status=status)
            )
            await session.commit()


async def _noop_handler(session: AsyncSession, event: StripeEvent) -> None:
    pass


@pytest.fixture(autouse=True)
def registered_handler(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(handlers.HANDLERS, HANDLED, _noop_handler)


@pytest.fixture
def settings() -> Settings:
    return make_settings(stripe_webhook_secret=SECRET)


@pytest.fixture
async def webhook(app: FastAPI, test_database_url: URL) -> AsyncIterator[Webhook]:
    engine = create_async_engine(test_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    app.state.session_factory = sessions
    queue = RecordingQueue(sessions=sessions)
    app.state.webhook_queue = queue
    app.dependency_overrides[get_job_queue] = _webhook_queue
    event_ids: list[str] = []
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            yield Webhook(app, client, sessions, queue, event_ids)
    finally:
        app.dependency_overrides.pop(get_job_queue, None)
        async with sessions() as session:
            await session.execute(
                delete(WebhookEvent).where(WebhookEvent.stripe_event_id.in_(event_ids))
            )
            await session.commit()
        await engine.dispose()


def event_body(
    event_id: str,
    event_type: str = HANDLED,
    *,
    livemode: bool = False,
    marker: str = "fixture",
) -> bytes:
    event = {
        "id": event_id,
        "object": "event",
        "type": event_type,
        "livemode": livemode,
        "created": CREATED,
        "api_version": "2026-10-28",
        "data": {"object": {"id": "obj_test_1", "object": "test", "note": marker}},
    }
    return json.dumps(event).encode()


def sign(body: bytes, secret: str = SECRET, timestamp: int | None = None) -> str:
    """Stripe's scheme: v1 = hex HMAC-SHA256 of "<t>.<body>" under the endpoint secret."""
    t = int(time.time()) if timestamp is None else timestamp
    digest = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return f"t={t},v1={digest}"


async def test_valid_event_with_handler_is_stored_pending_then_enqueued(
    webhook: Webhook,
) -> None:
    event_id = webhook.new_id()
    body = event_body(event_id)

    response = await webhook.post(body)

    assert response.status_code == 200
    assert response.json() == {"received": True}
    [row] = await webhook.rows(event_id)
    assert row.event_type == HANDLED
    assert row.livemode is False
    assert int(row.stripe_created_at.timestamp()) == CREATED
    assert row.status is WebhookEventStatus.PENDING
    assert row.attempts == 0
    assert row.processed_at is None
    assert row.last_error is None
    assert row.payload == json.loads(body)
    assert webhook.queue.jobs == {
        f"stripe-event:{event_id}": ("process_stripe_event", (str(row.id),))
    }
    # Queued after the commit: another connection already saw the pending row.
    assert webhook.queue.committed == ["pending"]


async def test_valid_event_without_handler_is_stored_ignored_and_not_enqueued(
    webhook: Webhook,
) -> None:
    event_id = webhook.new_id()

    response = await webhook.post(event_body(event_id, UNHANDLED))

    assert response.status_code == 200
    assert response.json() == {"received": True}
    [row] = await webhook.rows(event_id)
    assert row.event_type == UNHANDLED
    assert row.status is WebhookEventStatus.IGNORED
    assert row.processed_at is not None
    assert row.payload is None
    assert row.attempts == 0
    assert webhook.queue.calls == 0


@pytest.mark.parametrize(
    "settled",
    [WebhookEventStatus.PROCESSED, WebhookEventStatus.IGNORED, WebhookEventStatus.FAILED],
)
async def test_duplicate_event_is_a_noop(webhook: Webhook, settled: WebhookEventStatus) -> None:
    event_id = webhook.new_id()
    body = event_body(event_id)
    assert (await webhook.post(body)).status_code == 200
    [first] = await webhook.rows(event_id)
    await webhook.set_status(event_id, settled)
    webhook.queue.jobs.clear()
    calls = webhook.queue.calls

    response = await webhook.post(body)

    assert response.status_code == 200
    assert response.json() == {"received": True}
    [row] = await webhook.rows(event_id)
    assert row.id == first.id
    assert row.status is settled
    assert webhook.queue.calls == calls


async def test_duplicate_of_pending_event_reenqueues(webhook: Webhook) -> None:
    event_id = webhook.new_id()
    body = event_body(event_id)
    assert (await webhook.post(body)).status_code == 200
    [row] = await webhook.rows(event_id)
    job_id = f"stripe-event:{event_id}"

    # The first job is still queued: the same job id makes the enqueue a no-op.
    assert (await webhook.post(body)).status_code == 200
    assert webhook.queue.calls == 2
    assert list(webhook.queue.jobs) == [job_id]

    # The first job ended without settling the row (no result is kept): queued again.
    webhook.queue.jobs.clear()
    response = await webhook.post(body)

    assert response.status_code == 200
    assert webhook.queue.jobs == {job_id: ("process_stripe_event", (str(row.id),))}
    assert len(await webhook.rows(event_id)) == 1


async def test_concurrent_duplicate_deliveries_create_one_row(webhook: Webhook) -> None:
    event_id = webhook.new_id()
    body = event_body(event_id)
    # Another delivery of the same event has inserted its row but not committed yet.
    async with webhook.sessions() as other:
        await WebhookEventRepository(other).insert_new(
            stripe_event_id=event_id,
            event_type=HANDLED,
            livemode=False,
            stripe_created_at=datetime.fromtimestamp(CREATED, UTC),
            status=WebhookEventStatus.PENDING,
            payload=json.loads(body),
        )
        holder = await backend_pid(other)
        delivery = asyncio.create_task(webhook.post(body))
        await _wait_until_someone_waits_on(webhook.sessions, holder)
        await other.commit()
        response = await delivery

    assert response.status_code == 200
    rows = await webhook.rows(event_id)
    assert len(rows) == 1
    # The waiting insert did nothing and found the committed pending row: it queued that one.
    assert webhook.queue.jobs == {
        f"stripe-event:{event_id}": ("process_stripe_event", (str(rows[0].id),))
    }


async def test_simultaneous_deliveries_create_one_row(webhook: Webhook) -> None:
    event_id = webhook.new_id()
    body = event_body(event_id)

    responses = await asyncio.gather(*(webhook.post(body) for _ in range(5)))

    assert [r.status_code for r in responses] == [200] * 5
    assert len(await webhook.rows(event_id)) == 1
    assert list(webhook.queue.jobs) == [f"stripe-event:{event_id}"]


async def _wait_until_someone_waits_on(
    sessions: async_sessionmaker[AsyncSession], holder: int
) -> None:
    query = text(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity "
        "WHERE CAST(:holder AS integer) = ANY(pg_blocking_pids(pid)))"
    )
    # Each poll is the query itself, on its own connection (as conftest.wait_until_blocked).
    async with sessions() as monitor:
        async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
            while not await monitor.scalar(query, {"holder": holder}):
                pass


def _missing_header(body: bytes) -> tuple[bytes, str | None]:
    return body, None


def _wrong_secret(body: bytes) -> tuple[bytes, str | None]:
    return body, sign(body, secret="whsec_another_fixture_value")


def _tampered_body(body: bytes) -> tuple[bytes, str | None]:
    return body.replace(b'"note": "fixture"', b'"note": "changed"'), sign(body)


def _expired_timestamp(body: bytes) -> tuple[bytes, str | None]:
    return body, sign(body, timestamp=int(time.time()) - 301)


def _malformed_header(body: bytes) -> tuple[bytes, str | None]:
    return body, "v1=abc,t=not-a-time"


def _no_v1_signature(body: bytes) -> tuple[bytes, str | None]:
    return body, sign(body).replace("v1=", "v0=")


def _non_ascii_signature(body: bytes) -> tuple[bytes, str | None]:
    # Sent as latin-1 bytes; Starlette decodes header values as latin-1.
    return body, sign(body) + ",v1=" + chr(0xE9)


@pytest.mark.parametrize(
    "tamper",
    [
        _missing_header,
        _wrong_secret,
        _tampered_body,
        _expired_timestamp,
        _malformed_header,
        _no_v1_signature,
        _non_ascii_signature,
    ],
)
async def test_invalid_signature_returns_400(
    webhook: Webhook, tamper: Callable[[bytes], tuple[bytes, str | None]]
) -> None:
    event_id = webhook.new_id()
    body, signature = tamper(event_body(event_id))

    response = await webhook.post(body, signature, sign_it=False)

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_signature"
    assert await webhook.rows(event_id) == []
    assert webhook.queue.calls == 0


async def test_one_matching_signature_among_several_is_enough(webhook: Webhook) -> None:
    """Stripe sends one v1 per active secret while a secret is being rolled."""
    event_id = webhook.new_id()
    body = event_body(event_id)
    t = int(time.time())
    good = sign(body, timestamp=t).split(",v1=")[1]
    other = sign(body, secret="whsec_old_fixture_value", timestamp=t).split(",v1=")[1]

    response = await webhook.post(body, f"t={t},v1={other},v1={good}")

    assert response.status_code == 200
    assert len(await webhook.rows(event_id)) == 1


async def test_body_that_is_not_utf8_is_an_invalid_signature(webhook: Webhook) -> None:
    body = b'{"id": "evt_\xff"}'

    response = await webhook.post(body)

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_signature"


def _event(**overrides: object) -> dict[str, object]:
    event: dict[str, object] = {
        "id": "evt_test_payload",
        "type": HANDLED,
        "livemode": False,
        "created": CREATED,
    }
    event.update(overrides)
    return {key: value for key, value in event.items() if value is not ...}


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"",
        b"[]",
        b'"evt_test"',
        json.dumps(_event(id=...)).encode(),
        json.dumps(_event(id=42)).encode(),
        json.dumps(_event(id="")).encode(),
        json.dumps(_event(id="evt_" + "x" * 252)).encode(),
        json.dumps(_event(type=...)).encode(),
        json.dumps(_event(type=None)).encode(),
        json.dumps(_event(created=...)).encode(),
        json.dumps(_event(created="1761000000")).encode(),
        json.dumps(_event(created=1.5)).encode(),
        json.dumps(_event(created=True)).encode(),
        json.dumps(_event(created=10**20)).encode(),
        json.dumps(_event(livemode=...)).encode(),
        json.dumps(_event(livemode="false")).encode(),
        pytest.param(b"[" * 100_000 + b"]" * 100_000, id="nested-too-deep"),
    ],
)
async def test_invalid_payload_returns_400(webhook: Webhook, body: bytes) -> None:
    response = await webhook.post(body)

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_payload"
    assert await webhook.rows("evt_test_payload") == []
    assert webhook.queue.calls == 0


async def test_secret_unset_returns_503(webhook: Webhook, settings: Settings) -> None:
    webhook.app.state.settings = settings.model_copy(update={"stripe_webhook_secret": None})
    read = False

    async def chunks() -> AsyncIterator[bytes]:
        nonlocal read
        read = True
        yield event_body("evt_test_unread")

    response = await webhook.client.post(
        "/v1/webhooks/stripe", content=chunks(), headers={"Stripe-Signature": "t=1,v1=00"}
    )

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "not_configured"
    # Refused before the body was read.
    assert read is False
    assert webhook.queue.calls == 0


async def test_oversized_body_returns_413(webhook: Webhook) -> None:
    event_id = webhook.new_id()
    body = event_body(event_id, marker="x" * MAX_BODY)

    response = await webhook.post(body)

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"
    assert await webhook.rows(event_id) == []
    assert webhook.queue.calls == 0


async def test_oversized_stream_without_length_returns_413(webhook: Webhook) -> None:
    """No Content-Length (chunked): the read itself stops past the cap, and the signature is
    never checked (it is wrong here, which would be a 400)."""
    sent = 0

    async def chunks() -> AsyncIterator[bytes]:
        nonlocal sent
        for _ in range(100):
            sent += 1
            yield b"x" * 65_536

    response = await webhook.client.post(
        "/v1/webhooks/stripe", content=chunks(), headers={"Stripe-Signature": "t=1,v1=00"}
    )

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"
    assert sent < 100


async def test_body_at_the_cap_is_read(webhook: Webhook, settings: Settings) -> None:
    event_id = webhook.new_id()
    base = event_body(event_id, marker="")
    body = event_body(event_id, marker="x" * (settings.stripe_webhook_max_body_bytes - len(base)))
    assert len(body) == settings.stripe_webhook_max_body_bytes

    response = await webhook.post(body)

    assert response.status_code == 200


@pytest.mark.parametrize("failure", ["redis", "os", "hang"])
async def test_enqueue_failure_returns_500_and_redelivery_recovers(
    webhook: Webhook, settings: Settings, failure: str, caplog: pytest.LogCaptureFixture
) -> None:
    webhook.app.state.settings = settings.model_copy(update={"job_enqueue_timeout_seconds": 0.05})
    if failure == "hang":
        webhook.queue.hang = True
    else:
        webhook.queue.failure = RedisError("boom") if failure == "redis" else OSError("boom")
    event_id = webhook.new_id()
    body = event_body(event_id)

    with caplog.at_level(logging.ERROR, logger="app.modules.webhooks.service"):
        response = await webhook.post(body)

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"
    [record] = [r for r in caplog.records if r.getMessage() == "stripe_webhook_enqueue_failed"]
    assert getattr(record, "stripe_event_id", None) == event_id
    # The row is committed and pending.
    [row] = await webhook.rows(event_id)
    assert row.status is WebhookEventStatus.PENDING

    # Stripe delivers it again once Redis is back.
    webhook.queue.failure = None
    webhook.queue.hang = False
    response = await webhook.post(body)

    assert response.status_code == 200
    assert webhook.queue.jobs == {
        f"stripe-event:{event_id}": ("process_stripe_event", (str(row.id),))
    }
    assert len(await webhook.rows(event_id)) == 1


@pytest.mark.parametrize(
    ("app_env", "livemode", "expected"),
    [
        ("test", True, WebhookEventStatus.IGNORED),
        ("development", True, WebhookEventStatus.IGNORED),
        ("staging", True, WebhookEventStatus.IGNORED),
        ("production", False, WebhookEventStatus.IGNORED),
        ("production", True, WebhookEventStatus.PENDING),
        ("staging", False, WebhookEventStatus.PENDING),
    ],
)
async def test_livemode_mismatch_is_ignored(
    webhook: Webhook,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
    app_env: str,
    livemode: bool,
    expected: WebhookEventStatus,
) -> None:
    # model_copy skips validation: the deployed environments' required secrets are not needed.
    webhook.app.state.settings = settings.model_copy(update={"app_env": app_env})
    event_id = webhook.new_id()

    with caplog.at_level(logging.WARNING, logger="app.modules.webhooks.service"):
        response = await webhook.post(event_body(event_id, livemode=livemode))

    assert response.status_code == 200
    [row] = await webhook.rows(event_id)
    assert row.status is expected
    warnings = [r for r in caplog.records if r.getMessage() == "stripe_webhook_livemode_mismatch"]
    if expected is WebhookEventStatus.IGNORED:
        assert row.payload is None
        assert row.processed_at is not None
        assert webhook.queue.calls == 0
        [warning] = warnings
        assert getattr(warning, "stripe_event_id", None) == event_id
    else:
        assert warnings == []
        assert webhook.queue.calls == 1


async def test_webhook_logs_carry_no_payload_or_signature(
    webhook: Webhook, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    sentinel = f"SENTINEL-{uuid.uuid4().hex}"
    signatures: list[str] = []

    async def deliver(body: bytes, signature: str | None = None) -> None:
        signature = signature or sign(body)
        signatures.append(signature)
        await webhook.post(body, signature)

    steps: list[Callable[[], Awaitable[None]]] = []
    handled, unhandled, failing = webhook.new_id(), webhook.new_id(), webhook.new_id()
    steps.append(lambda: deliver(event_body(handled, marker=sentinel)))
    steps.append(lambda: deliver(event_body(handled, marker=sentinel)))
    steps.append(lambda: deliver(event_body(unhandled, UNHANDLED, marker=sentinel)))
    steps.append(lambda: deliver(event_body(webhook.new_id(), livemode=True, marker=sentinel)))
    bad = event_body(webhook.new_id(), marker=sentinel)
    steps.append(lambda: deliver(bad, sign(bad, secret="whsec_another_fixture_value")))
    steps.append(lambda: deliver(json.dumps({"note": sentinel}).encode()))

    async def failing_enqueue() -> None:
        webhook.queue.failure = RedisError(sentinel)
        await deliver(event_body(failing, marker=sentinel))
        webhook.queue.failure = None

    steps.append(failing_enqueue)

    with caplog.at_level(logging.DEBUG):
        for step in steps:
            await step()

    assert caplog.records
    forbidden = [sentinel, SECRET, *signatures, *(s.split("v1=")[1] for s in signatures)]
    for record in caplog.records:
        rendered = json.dumps(vars(record), default=str)
        for value in forbidden:
            assert value not in rendered, record.getMessage()
