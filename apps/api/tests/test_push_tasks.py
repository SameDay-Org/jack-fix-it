"""The push worker tasks (D10.3, #54): a fake sender, real Redis under a unique prefix, and the
rolled-back test session. No network."""

import json
import logging
import uuid
from collections import Counter
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from arq import Retry
from arq.worker import Function
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.expo_push import (
    SEND_BATCH,
    ExpoPushSender,
    PushMessage,
    PushUnavailableError,
    Receipt,
    Ticket,
)
from app.modules.devices.models import Device, DevicePlatform
from app.modules.devices.service import DeviceService
from app.modules.notifications.push_tasks import (
    PushStateNotStoredError,
    PushStore,
    Recipient,
    check_push_receipts,
    send_push,
)
from app.modules.notifications.service import InvalidPushError
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from app.worker import WorkerSettings, every
from tests.conftest import make_settings
from tests.test_notification_catalog import FakeQueue

DEEP_LINK = f"/requests/{uuid.UUID(int=7)}"
PARAMS = {"public_code": "JF-000124"}
BACKOFF = 7  # not the default (30)
TICKET_TTL = 3_600
MAX_ATTEMPTS = 3  # not the default (5)
BUSY = "ExponentPushToken[busy]"
OK = "ExponentPushToken[ok]"
RATE_LIMITED = "MessageRateExceeded"


@dataclass
class FakeSender:
    sent: list[list[PushMessage]] = field(default_factory=list)
    errors: dict[str, str] = field(default_factory=dict)  # token -> ticket error
    fail: Exception | None = None
    receipts: dict[str, Receipt] = field(default_factory=dict)
    asked: list[list[str]] = field(default_factory=list)

    async def send(self, messages: Sequence[PushMessage]) -> list[Ticket]:
        if self.fail is not None:
            raise self.fail
        self.sent.append(list(messages))
        return [
            Ticket(id=None, error=self.errors[m.to])
            if m.to in self.errors
            else Ticket(id=f"ticket-{m.to}")
            for m in messages
        ]

    async def get_receipts(self, ticket_ids: Sequence[str]) -> dict[str, Receipt]:
        if self.fail is not None:
            raise self.fail
        self.asked.append(list(ticket_ids))
        return {t: r for t, r in self.receipts.items() if t in ticket_ids}


def sessions_of(
    session: AsyncSession,
) -> Callable[[], AbstractAsyncContextManager[AsyncSession]]:
    @asynccontextmanager
    async def factory() -> AsyncIterator[AsyncSession]:
        yield session

    return factory


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        push_retry_backoff_seconds=BACKOFF,
        push_ticket_ttl_seconds=TICKET_TTL,
        push_max_attempts=MAX_ATTEMPTS,
    )


@pytest.fixture
async def redis() -> AsyncIterator[Redis]:
    client = Redis.from_url(Settings().redis_url)
    try:
        yield client
    finally:
        await client.aclose()


@pytest.fixture
async def prefix(redis: Redis) -> AsyncIterator[str]:
    prefix = f"push-test-{uuid.uuid4().hex}"
    yield prefix
    keys = [key async for key in redis.scan_iter(match=f"{prefix}:*")]
    if keys:
        await redis.delete(*keys)


@pytest.fixture
def sender() -> FakeSender:
    return FakeSender()


@pytest.fixture
def queue() -> FakeQueue:
    return FakeQueue()


@pytest.fixture
def ctx(
    settings: Settings,
    db_session: AsyncSession,
    redis: Redis,
    prefix: str,
    sender: FakeSender,
    queue: FakeQueue,
) -> dict[str, Any]:
    return {
        "settings": settings,
        "session_factory": sessions_of(db_session),
        "push_sender": sender,
        "redis": redis,
        "push_key_prefix": prefix,
        "push_queue": queue,
        "job_try": 1,
    }


async def make_user(session: AsyncSession, locale: str = "en", *tokens: str) -> User:
    user = User(
        email=f"u-{uuid.uuid4().hex[:8]}@x.com",
        password_hash="x",
        role=UserRole.CUSTOMER,
        locale=locale,
    )
    session.add(user)
    await session.flush()
    session.add_all(
        Device(
            user_id=user.id,
            expo_push_token=t,
            platform=DevicePlatform.ANDROID,
            last_seen_at=datetime.now(UTC),
        )
        for t in tokens
    )
    await session.flush()
    return user


async def push(ctx: dict[str, Any], user: User, message_id: str = "test:1", **kw: Any) -> None:
    await send_push(
        ctx,
        str(user.id),
        message_id,
        kw.get("title_key", "push.test.title"),
        kw.get("body_key", "push.test.body"),
        kw.get("params", PARAMS),
        kw.get("deep_link", DEEP_LINK),
    )


async def device_tokens(session: AsyncSession) -> set[str]:
    statement = select(Device.expo_push_token).execution_options(populate_existing=True)
    return set((await session.scalars(statement)).all())


async def ticket_ids(redis: Redis, prefix: str) -> set[str]:
    """The tickets waiting for a receipt."""
    keys = [key.decode() async for key in redis.scan_iter(match=f"{prefix}:ticket:*")]
    return {key.removeprefix(f"{prefix}:ticket:") for key in keys}


def sent_to(sender: FakeSender) -> Counter[str]:
    """How many times each push token was sent the message."""
    return Counter(message.to for batch in sender.sent for message in batch)


async def test_send_resolves_locale_and_sends_to_all_devices(
    ctx: dict[str, Any], db_session: AsyncSession, sender: FakeSender, redis: Redis, prefix: str
) -> None:
    maria = await make_user(db_session, "es", "ExponentPushToken[m1]", "ExponentPushToken[m2]")
    await make_user(db_session, "en", "ExponentPushToken[other]")

    await push(ctx, maria)

    [batch] = sender.sent
    assert {m.to for m in batch} == {"ExponentPushToken[m1]", "ExponentPushToken[m2]"}
    for message in batch:
        assert message.title == "Jack Fix It"
        assert message.body == "Esta es una notificación de prueba para JF-000124."
        assert message.data == {"url": DEEP_LINK}
    devices = {d.expo_push_token: d.id for d in (await db_session.scalars(select(Device))).all()}
    for token in ("ExponentPushToken[m1]", "ExponentPushToken[m2]"):
        stored = await redis.get(f"{prefix}:ticket:ticket-{token}")
        assert stored is not None
        assert stored.decode() == f"{devices[token]} test:1"
        assert 0 < await redis.ttl(f"{prefix}:ticket:ticket-{token}") <= TICKET_TTL


async def test_device_not_registered_ticket_deletes_device(
    ctx: dict[str, Any], db_session: AsyncSession, sender: FakeSender, redis: Redis, prefix: str
) -> None:
    user = await make_user(
        db_session,
        "en",
        "ExponentPushToken[live]",
        "ExponentPushToken[dead]",
        "ExponentPushToken[busy]",
    )
    sender.errors = {
        "ExponentPushToken[dead]": "DeviceNotRegistered",
        "ExponentPushToken[busy]": "MessageRateExceeded",
    }

    with pytest.raises(Retry):  # for the rate-limited device only
        await push(ctx, user)

    assert await device_tokens(db_session) == {"ExponentPushToken[live]", "ExponentPushToken[busy]"}
    tickets = [key async for key in redis.scan_iter(match=f"{prefix}:ticket:*")]
    assert [key.decode() for key in tickets] == [f"{prefix}:ticket:ticket-ExponentPushToken[live]"]


async def test_receipts_cron_deletes_dead_devices_and_clears_tickets(
    ctx: dict[str, Any], db_session: AsyncSession, sender: FakeSender, redis: Redis, prefix: str
) -> None:
    user = await make_user(
        db_session,
        "en",
        "ExponentPushToken[ok]",
        "ExponentPushToken[dead]",
        "ExponentPushToken[later]",
    )
    await push(ctx, user)
    sender.receipts = {
        "ticket-ExponentPushToken[ok]": Receipt(ok=True),
        "ticket-ExponentPushToken[dead]": Receipt(ok=False, error="DeviceNotRegistered"),
        # No receipt yet for "later": it stays for the next run.
    }

    await check_push_receipts(ctx)

    [asked] = sender.asked
    assert set(asked) == {
        "ticket-ExponentPushToken[ok]",
        "ticket-ExponentPushToken[dead]",
        "ticket-ExponentPushToken[later]",
    }
    assert await device_tokens(db_session) == {"ExponentPushToken[ok]", "ExponentPushToken[later]"}
    left = [key.decode() async for key in redis.scan_iter(match=f"{prefix}:ticket:*")]
    assert left == [f"{prefix}:ticket:ticket-ExponentPushToken[later]"]


async def test_receipts_unavailable_keeps_tickets(
    ctx: dict[str, Any], db_session: AsyncSession, sender: FakeSender, redis: Redis, prefix: str
) -> None:
    user = await make_user(db_session, "en", "ExponentPushToken[a]")
    await push(ctx, user)
    sender.fail = PushUnavailableError()

    await check_push_receipts(ctx)  # never raises: the next run tries again

    assert [key async for key in redis.scan_iter(match=f"{prefix}:ticket:*")]
    assert await device_tokens(db_session) == {"ExponentPushToken[a]"}


async def test_send_is_idempotent_for_same_message_id(
    ctx: dict[str, Any], db_session: AsyncSession, sender: FakeSender
) -> None:
    user = await make_user(db_session, "en", "ExponentPushToken[a]")

    await push(ctx, user, "quote_ready:1")
    await push(ctx, user, "quote_ready:1")
    await push(ctx, user, "quote_ready:2")

    assert len(sender.sent) == 2


async def test_failed_send_is_retried_with_backoff(
    ctx: dict[str, Any], db_session: AsyncSession, sender: FakeSender
) -> None:
    user = await make_user(db_session, "en", "ExponentPushToken[a]")
    sender.fail = PushUnavailableError()
    ctx["job_try"] = 2  # MAX_ATTEMPTS is the last: no retry after it

    with pytest.raises(Retry) as retry:
        await push(ctx, user)

    assert retry.value.defer_score == BACKOFF * 2 * 1000  # ARQ keeps milliseconds
    # The device is still pending, so the retry sends.
    sender.fail = None
    await push(ctx, user)
    assert len(sender.sent) == 1


async def test_deep_link_outside_allowlist_rejected(
    ctx: dict[str, Any], db_session: AsyncSession, sender: FakeSender, redis: Redis, prefix: str
) -> None:
    user = await make_user(db_session, "en", "ExponentPushToken[a]")

    with pytest.raises(InvalidPushError):
        await push(ctx, user, deep_link="https://evil.example/requests/1")

    assert sender.sent == []
    assert not [key async for key in redis.scan_iter(match=f"{prefix}:*")]


async def test_no_devices_or_no_user_sends_nothing(
    ctx: dict[str, Any], db_session: AsyncSession, sender: FakeSender
) -> None:
    lonely = await make_user(db_session, "en")

    await push(ctx, lonely, "a:1")
    await send_push(
        ctx, str(uuid.uuid4()), "a:2", "push.test.title", "push.test.body", PARAMS, DEEP_LINK
    )

    assert sender.sent == []


async def test_logs_carry_ids_and_counts_only(
    ctx: dict[str, Any],
    db_session: AsyncSession,
    sender: FakeSender,
    caplog: pytest.LogCaptureFixture,
) -> None:
    user = await make_user(db_session, "en", "ExponentPushToken[probe-secret]")
    sender.receipts = {"ticket-ExponentPushToken[probe-secret]": Receipt(ok=True)}

    with caplog.at_level(logging.DEBUG):
        await push(ctx, user)
        await check_push_receipts(ctx)

    output = "\n".join(JsonFormatter().format(record) for record in caplog.records)
    for secret in ("probe-secret", "JF-000124", "notification for", "Jack Fix It"):
        assert secret not in output
    messages = {record.message for record in caplog.records}
    assert {"push_sent", "push_receipts_checked"} <= messages


def test_worker_registers_the_tasks_and_the_cron() -> None:
    [task] = [
        f for f in WorkerSettings.functions if isinstance(f, Function) and f.name == "send_push"
    ]
    assert task.coroutine is send_push
    assert task.name == "send_push"
    assert task.keep_result_s == 0  # a resend can queue the message's job id again
    assert task.max_tries == Settings().push_max_attempts
    [job] = WorkerSettings.cron_jobs
    assert job.coroutine is check_push_receipts
    assert every(15) == {0, 15, 30, 45}
    assert every(60) == {0}


async def test_rate_limited_ticket_is_retried_for_that_device_only(
    ctx: dict[str, Any], db_session: AsyncSession, sender: FakeSender, redis: Redis, prefix: str
) -> None:
    user = await make_user(db_session, "en", BUSY, OK)
    sender.errors = {BUSY: RATE_LIMITED}

    with pytest.raises(Retry) as retry:
        await push(ctx, user)
    assert retry.value.defer_score == BACKOFF * 1000
    assert await ticket_ids(redis, prefix) == {f"ticket-{OK}"}

    sender.errors = {}
    ctx["job_try"] = 2
    await push(ctx, user)

    assert sent_to(sender) == {BUSY: 2, OK: 1}
    assert await ticket_ids(redis, prefix) == {f"ticket-{BUSY}", f"ticket-{OK}"}


async def test_rate_limited_receipt_resends_to_that_device_only(
    ctx: dict[str, Any],
    db_session: AsyncSession,
    sender: FakeSender,
    queue: FakeQueue,
    redis: Redis,
    prefix: str,
) -> None:
    user = await make_user(db_session, "en", BUSY, OK)
    await push(ctx, user)
    sender.receipts = {
        f"ticket-{BUSY}": Receipt(ok=False, error=RATE_LIMITED),
        f"ticket-{OK}": Receipt(ok=True),
    }

    await check_push_receipts(ctx)

    assert queue.jobs == {
        "push:test:1": (
            "send_push",
            (str(user.id), "test:1", "push.test.title", "push.test.body", PARAMS, DEEP_LINK),
        )
    }
    assert await ticket_ids(redis, prefix) == set()
    await push(ctx, user)  # the worker runs the queued job
    assert sent_to(sender) == {BUSY: 2, OK: 1}
    assert await ticket_ids(redis, prefix) == {f"ticket-{BUSY}"}


async def test_receipt_resend_waits_while_a_run_of_the_message_exists(
    ctx: dict[str, Any],
    db_session: AsyncSession,
    sender: FakeSender,
    queue: FakeQueue,
    redis: Redis,
    prefix: str,
) -> None:
    user = await make_user(db_session, "en", BUSY)
    await push(ctx, user)
    sender.receipts = {f"ticket-{BUSY}": Receipt(ok=False, error=RATE_LIMITED)}
    queue.jobs["push:test:1"] = ("send_push", ())  # queued or running; may have read already

    await check_push_receipts(ctx)
    assert await ticket_ids(redis, prefix) == {f"ticket-{BUSY}"}  # kept for the next check

    del queue.jobs["push:test:1"]  # that run ended
    await check_push_receipts(ctx)
    assert list(queue.jobs) == ["push:test:1"]
    assert await ticket_ids(redis, prefix) == set()


async def test_retryable_device_fails_after_max_attempts(
    ctx: dict[str, Any],
    db_session: AsyncSession,
    sender: FakeSender,
    caplog: pytest.LogCaptureFixture,
) -> None:
    user = await make_user(db_session, "en", BUSY)
    sender.errors = {BUSY: RATE_LIMITED}
    for attempt in range(1, MAX_ATTEMPTS):
        ctx["job_try"] = attempt
        with pytest.raises(Retry):
            await push(ctx, user)

    ctx["job_try"] = MAX_ATTEMPTS
    with caplog.at_level(logging.WARNING):
        await push(ctx, user)  # no Retry: the device is done with
    await push(ctx, user)

    assert sent_to(sender) == {BUSY: MAX_ATTEMPTS}
    [failed] = [r for r in caplog.records if r.message == "push_recipient_failed"]
    assert failed.__dict__["attempts"] == MAX_ATTEMPTS
    assert failed.__dict__["error"] == RATE_LIMITED


async def test_rate_limited_receipt_after_max_attempts_fails_the_device(
    ctx: dict[str, Any],
    db_session: AsyncSession,
    sender: FakeSender,
    queue: FakeQueue,
    redis: Redis,
    prefix: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    user = await make_user(db_session, "en", BUSY)
    sender.errors = {BUSY: RATE_LIMITED}
    for attempt in range(1, MAX_ATTEMPTS):
        ctx["job_try"] = attempt
        with pytest.raises(Retry):
            await push(ctx, user)
    sender.errors = {}
    ctx["job_try"] = MAX_ATTEMPTS
    await push(ctx, user)  # accepted on the last send it may have
    sender.receipts = {f"ticket-{BUSY}": Receipt(ok=False, error=RATE_LIMITED)}

    with caplog.at_level(logging.WARNING):
        await check_push_receipts(ctx)

    assert queue.jobs == {}
    assert await ticket_ids(redis, prefix) == set()
    assert [r for r in caplog.records if r.message == "push_recipient_failed"]


async def test_failed_later_batch_never_resends_the_accepted_one(
    ctx: dict[str, Any], settings: Settings, db_session: AsyncSession, redis: Redis, prefix: str
) -> None:
    sizes: list[int] = []
    accepted: Counter[str] = Counter()

    def expo(request: httpx.Request) -> httpx.Response:
        batch = json.loads(request.content)
        sizes.append(len(batch))
        if len(sizes) == 2:
            return httpx.Response(503, json={"errors": [{"message": "temporary outage"}]})
        accepted.update(message["to"] for message in batch)
        data = [{"status": "ok", "id": f"ticket-{message['to']}"} for message in batch]
        return httpx.Response(200, json={"data": data})

    tokens = [f"ExponentPushToken[batch-{n}]" for n in range(SEND_BATCH + 1)]
    ctx["settings"] = settings.model_copy(update={"push_max_devices_per_user": len(tokens)})
    ctx["push_sender"] = ExpoPushSender(
        access_token=None, timeout_seconds=5, transport=httpx.MockTransport(expo)
    )
    user = await make_user(db_session, "en", *tokens)

    with pytest.raises(Retry):
        await push(ctx, user)
    ctx["job_try"] = 2
    await push(ctx, user)

    assert sizes == [SEND_BATCH, 1, 1]
    assert accepted == Counter(tokens)  # each device exactly once
    assert await ticket_ids(redis, prefix) == {f"ticket-{token}" for token in tokens}


async def test_cleanup_failure_keeps_tickets_and_retries_the_cleanup_only(
    ctx: dict[str, Any],
    db_session: AsyncSession,
    sender: FakeSender,
    redis: Redis,
    prefix: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = await make_user(db_session, "en", "ExponentPushToken[dead]", OK)
    sender.errors = {"ExponentPushToken[dead]": "DeviceNotRegistered"}
    forget = DeviceService.forget

    async def database_down(self: DeviceService, device_id: uuid.UUID) -> None:
        raise SQLAlchemyError("synthetic outage")

    monkeypatch.setattr(DeviceService, "forget", database_down)
    with pytest.raises(Retry):
        await push(ctx, user)
    assert await ticket_ids(redis, prefix) == {f"ticket-{OK}"}
    assert await device_tokens(db_session) == {"ExponentPushToken[dead]", OK}

    monkeypatch.setattr(DeviceService, "forget", forget)
    ctx["job_try"] = 2
    await push(ctx, user)

    assert len(sender.sent) == 1  # the retry only deleted the device
    assert await device_tokens(db_session) == {OK}
    assert await ticket_ids(redis, prefix) == {f"ticket-{OK}"}


# Round 2 (B6): a state write that fails around the send never leads to a second send.


def fail_writes(monkeypatch: pytest.MonkeyPatch, status: str, times: int) -> list[str]:
    """Makes the store's writes that carry a recipient in `status` raise RedisError, `times`
    times (the real Redis write runs otherwise). Returns the failures so far."""
    record = PushStore.record
    failures: list[str] = []

    async def flaky(
        self: PushStore, message_id: str, recipients: Mapping[uuid.UUID, Recipient]
    ) -> None:
        if len(failures) < times and any(r.status == status for r in recipients.values()):
            failures.append(status)
            raise RedisError("synthetic outage")
        await record(self, message_id, recipients)

    monkeypatch.setattr(PushStore, "record", flaky)
    return failures


async def statuses(redis: Redis, prefix: str, message_id: str = "test:1") -> list[str]:
    store = PushStore(redis, ttl_seconds=TICKET_TTL, timeout_seconds=5, prefix=prefix)
    return [str(r.status) for r in (await store.delivery(message_id) or {}).values()]


async def test_lost_outcome_write_never_resends(
    ctx: dict[str, Any],
    db_session: AsyncSession,
    sender: FakeSender,
    redis: Redis,
    prefix: str,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    user = await make_user(db_session, "en", OK)
    fail_writes(monkeypatch, "accepted", times=1_000)  # Expo took it; Redis never stores that

    with caplog.at_level(logging.WARNING), pytest.raises(Retry):
        await push(ctx, user)
    assert [r for r in caplog.records if r.message == "push_state_not_stored"]
    assert await statuses(redis, prefix) == ["in_flight"]

    monkeypatch.undo()  # Redis is back
    ctx["job_try"] = 2
    with caplog.at_level(logging.WARNING):
        await push(ctx, user)  # ARQ's retry
    ctx["job_try"] = 1
    await push(ctx, user)  # a later job with the same id (a resend from a receipt)

    assert sent_to(sender) == {OK: 1}
    assert await statuses(redis, prefix) == ["unknown"]
    [unknown] = [r for r in caplog.records if r.message == "push_outcome_unknown"]
    assert unknown.__dict__["count"] == 1


async def test_failed_in_flight_write_sends_nothing_and_retries(
    ctx: dict[str, Any],
    db_session: AsyncSession,
    sender: FakeSender,
    redis: Redis,
    prefix: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = await make_user(db_session, "en", OK)
    fail_writes(monkeypatch, "in_flight", times=1)

    with pytest.raises(Retry):
        await push(ctx, user)
    assert sender.sent == []
    assert await statuses(redis, prefix) == ["pending"]

    ctx["job_try"] = 2
    await push(ctx, user)

    assert sent_to(sender) == {OK: 1}
    assert await statuses(redis, prefix) == ["accepted"]


async def test_transient_outcome_write_failure_is_retried_without_resending(
    ctx: dict[str, Any],
    db_session: AsyncSession,
    sender: FakeSender,
    redis: Redis,
    prefix: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = await make_user(db_session, "en", OK)
    failures = fail_writes(monkeypatch, "accepted", times=1)

    await push(ctx, user)  # no Retry: the second write of the outcome went through
    await push(ctx, user)

    assert failures == ["accepted"]
    assert sent_to(sender) == {OK: 1}
    assert await statuses(redis, prefix) == ["accepted"]
    assert await ticket_ids(redis, prefix) == {f"ticket-{OK}"}


async def test_lost_outcome_write_on_the_last_try_fails_the_job(
    ctx: dict[str, Any],
    db_session: AsyncSession,
    sender: FakeSender,
    redis: Redis,
    prefix: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = await make_user(db_session, "en", OK)
    fail_writes(monkeypatch, "accepted", times=1_000)
    ctx["job_try"] = MAX_ATTEMPTS  # ARQ runs it no more: the job must not end as a success

    with pytest.raises(PushStateNotStoredError):
        await push(ctx, user)

    assert sent_to(sender) == {OK: 1}
    assert await statuses(redis, prefix) == ["in_flight"]  # never sent again
