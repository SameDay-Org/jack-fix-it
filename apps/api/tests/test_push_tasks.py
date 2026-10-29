"""The push worker tasks (D10.3, #54): a fake sender, real Redis under a unique prefix, and the
rolled-back test session. No network."""

import json
import logging
import uuid
from collections import Counter
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, cast

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
from app.modules.notifications.models import NotificationPreference
from app.modules.notifications.preferences import PREFERENCE_GROUPS, Channel, PreferenceGroup
from app.modules.notifications.preferences_service import NotificationPreferenceService
from app.modules.notifications.push_tasks import (
    PushStateNotStoredError,
    PushStore,
    Recipient,
    Status,
    check_push_receipts,
    send_push,
)
from app.modules.notifications.service import InvalidPushError
from app.modules.users.models import User
from app.modules.users.types import UserRole, UserStatus
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


async def test_suspended_user_gets_no_push(
    ctx: dict[str, Any],
    db_session: AsyncSession,
    sender: FakeSender,
    caplog: pytest.LogCaptureFixture,
) -> None:
    # Checked when the message runs (#55): a user suspended after the event was queued.
    user = await make_user(db_session, "en", "ExponentPushToken[suspended]")
    user.status = UserStatus.SUSPENDED
    await db_session.flush()

    with caplog.at_level(logging.INFO):
        await push(ctx, user, "a:3")

    assert sender.sent == []
    [record] = [r for r in caplog.records if r.message == "push_user_not_active"]
    assert record.__dict__["user_id"] == str(user.id)
    # It stops there: no "no devices" or "already sent", which would misread the run.
    assert {r.message for r in caplog.records} & {"push_no_devices", "push_already_sent"} == set()
    # The same user, active again, is sent a new message: only the status stopped it.
    user.status = UserStatus.ACTIVE
    await db_session.flush()
    await push(ctx, user, "a:4")
    assert sent_to(sender) == Counter({"ExponentPushToken[suspended]": 1})


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
    [job] = [j for j in WorkerSettings.cron_jobs if j.name == "cron:check_push_receipts"]
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


# Notification preferences (#217): checked when the message runs.


def kind_keys(kind: str) -> dict[str, str]:
    return {"title_key": f"push.{kind}.title", "body_key": f"push.{kind}.body"}


QUOTE = kind_keys("new_quote")


async def set_preference(
    session: AsyncSession, user: User, group: str, enabled: bool, channel: str = "push"
) -> None:
    row = await session.get(NotificationPreference, (user.id, group, channel))
    if row is None:
        session.add(
            NotificationPreference(user_id=user.id, group=group, channel=channel, enabled=enabled)
        )
    else:
        row.enabled = enabled
    await session.flush()


async def test_send_push_muted_group_sends_nothing(
    ctx: dict[str, Any],
    db_session: AsyncSession,
    sender: FakeSender,
    redis: Redis,
    prefix: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    user = await make_user(db_session, "en", BUSY, OK)
    await set_preference(db_session, user, "quotes_and_opportunities", False)

    with caplog.at_level(logging.DEBUG):
        await push(ctx, user, "quote:1", **QUOTE)

    assert sender.sent == []
    assert await statuses(redis, prefix, "quote:1") == ["failed", "failed"]  # muted
    [record] = [r for r in caplog.records if r.message == "push_muted"]
    assert record.__dict__["user_id"] == str(user.id)
    assert record.__dict__["group"] == "quotes_and_opportunities"
    assert record.__dict__["count"] == 2
    assert {r.message for r in caplog.records} & {"push_no_devices", "push_already_sent"} == set()
    output = "\n".join(JsonFormatter().format(r) for r in caplog.records)
    for text in ("JF-000124", "new quote", "A pro sent"):
        assert text not in output
    # Turned back on: a retry of the muted message still sends nothing (no resend).
    await set_preference(db_session, user, "quotes_and_opportunities", True)
    await push({**ctx, "job_try": 2}, user, "quote:1", **QUOTE)
    assert sender.sent == []
    # A new message of the group goes out again.
    await push(ctx, user, "quote:2", **QUOTE)
    assert sent_to(sender) == {BUSY: 1, OK: 1}


async def test_receipt_resend_while_muted_sends_nothing(
    ctx: dict[str, Any],
    db_session: AsyncSession,
    sender: FakeSender,
    queue: FakeQueue,
    redis: Redis,
    prefix: str,
) -> None:
    user = await make_user(db_session, "en", BUSY, OK)
    await push(ctx, user, "quote:1", **QUOTE)
    sender.receipts = {f"ticket-{BUSY}": Receipt(ok=False, error=RATE_LIMITED)}
    await set_preference(db_session, user, "quotes_and_opportunities", False)

    await check_push_receipts(ctx)
    assert set(queue.jobs) == {"push:quote:1"}
    await push(ctx, user, "quote:1", **QUOTE)  # the worker runs the queued job

    assert sent_to(sender) == {BUSY: 1, OK: 1}  # the first send only
    assert sorted(await statuses(redis, prefix, "quote:1")) == ["accepted", "failed"]


async def test_send_push_default_and_enabled_send(
    ctx: dict[str, Any], db_session: AsyncSession, sender: FakeSender
) -> None:
    by_default = await make_user(db_session, "en", "ExponentPushToken[default]")
    chose_on = await make_user(db_session, "en", "ExponentPushToken[on]")
    await set_preference(db_session, chose_on, "job_updates", True)
    # Another group, or another channel of the group, turned off mutes nothing here.
    await set_preference(db_session, chose_on, "quotes_and_opportunities", False)
    await set_preference(db_session, chose_on, "marketing", False, channel="email")

    await push(ctx, by_default, "request:1", **kind_keys("new_request"))
    await push(ctx, chose_on, "accepted:1", **kind_keys("quote_accepted"))

    assert sent_to(sender) == {"ExponentPushToken[default]": 1, "ExponentPushToken[on]": 1}


async def test_test_push_never_muted(
    ctx: dict[str, Any], db_session: AsyncSession, sender: FakeSender
) -> None:
    user = await make_user(db_session, "en", OK)
    for spec in PREFERENCE_GROUPS:  # every pair off, the locked ones too (written directly)
        for channel in spec.channels:
            await set_preference(db_session, user, spec.group, False, channel=channel)

    await push(ctx, user)  # push.test.*

    assert sent_to(sender) == {OK: 1}


# Round 1 (#231, B1): a worker of the previous version (a rollback, or two versions running
# during a deploy) reads the delivery state this one stores. develop 3dcd842's reader, copied
# here on purpose and never imported: it must not follow later changes to push_tasks.


class PreviousStatus(StrEnum):
    """develop 3dcd842's Status: the only values a stored state may hold."""

    PENDING = "pending"
    ACCEPTED = "accepted"
    DEAD = "dead"
    GONE = "gone"
    FAILED = "failed"
    IN_FLIGHT = "in_flight"
    UNKNOWN = "unknown"


# What develop 3dcd842 reads as final: never sent again, nothing left to clean up.
PREVIOUS_FINAL = {PreviousStatus.GONE, PreviousStatus.FAILED, PreviousStatus.UNKNOWN}
DEAD = "ExponentPushToken[dead]"
GROUP = "quotes_and_opportunities"


def previous_delivery(
    fields: Mapping[bytes, bytes],
) -> dict[uuid.UUID, tuple[PreviousStatus, int, str | None]]:
    """develop 3dcd842's PushStore.delivery and Recipient.decode: it decodes every device of
    the message, and one status it does not know raises ValueError."""

    def text(value: bytes) -> str:
        return value.decode()

    decoded: dict[uuid.UUID, tuple[PreviousStatus, int, str | None]] = {}
    for name, value in fields.items():
        if text(name) == "request":
            continue
        status, attempts, ticket_id = text(value).split(":", 2)
        decoded[uuid.UUID(text(name))] = (PreviousStatus(status), int(attempts), ticket_id or None)
    return decoded


async def device_ids(session: AsyncSession, user: User) -> dict[str, uuid.UUID]:
    devices = await session.scalars(select(Device).where(Device.user_id == user.id))
    return {device.expo_push_token: device.id for device in devices}


async def mixed_quote(
    ctx: dict[str, Any], session: AsyncSession, sender: FakeSender, queue: FakeQueue, user: User
) -> None:
    """quote:1 as this worker leaves it with OK accepted and BUSY muted: both were sent, BUSY's
    receipt asked for a resend, and the group was turned off before the resend ran."""
    await push(ctx, user, "quote:1", **QUOTE)
    sender.receipts = {f"ticket-{BUSY}": Receipt(ok=False, error=RATE_LIMITED)}
    await set_preference(session, user, GROUP, False)
    await check_push_receipts(ctx)
    await push(ctx, user, "quote:1", **QUOTE)  # the queued resend: BUSY is muted
    queue.jobs.clear()  # that job ran
    sender.receipts = {}


async def test_stored_statuses_are_readable_by_previous_worker(
    ctx: dict[str, Any],
    db_session: AsyncSession,
    sender: FakeSender,
    queue: FakeQueue,
    redis: Redis,
    prefix: str,
) -> None:
    # Every status this worker can store (a mute among them) is one the previous worker knows.
    assert {status.value for status in Status} <= {status.value for status in PreviousStatus}

    user = await make_user(db_session, "en", BUSY, OK)
    await mixed_quote(ctx, db_session, sender, queue, user)
    fields = await cast(Awaitable[dict[bytes, bytes]], redis.hgetall(f"{prefix}:message:quote:1"))

    decoded = previous_delivery(fields)  # raises on a status it does not know

    ids = await device_ids(db_session, user)
    assert decoded[ids[OK]] == (PreviousStatus.ACCEPTED, 1, f"ticket-{OK}")
    muted, _, _ = decoded[ids[BUSY]]
    assert muted in PREVIOUS_FINAL  # final: the previous worker never sends it again
    assert muted is not PreviousStatus.PENDING  # not due


async def test_receipt_sweep_with_mixed_accepted_and_muted_delivery(
    ctx: dict[str, Any],
    db_session: AsyncSession,
    sender: FakeSender,
    queue: FakeQueue,
    redis: Redis,
    prefix: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    user = await make_user(db_session, "en", BUSY, OK)
    await mixed_quote(ctx, db_session, sender, queue, user)
    other = await make_user(db_session, "en", DEAD)
    await push(ctx, other, "test:2")  # an unrelated message
    assert await ticket_ids(redis, prefix) == {f"ticket-{OK}", f"ticket-{DEAD}"}
    sender.receipts = {
        f"ticket-{OK}": Receipt(ok=False, error=RATE_LIMITED),
        f"ticket-{DEAD}": Receipt(ok=False, error="DeviceNotRegistered"),
    }

    caplog.clear()  # mixed_quote ran a sweep already
    with caplog.at_level(logging.INFO):
        await check_push_receipts(ctx)

    assert set(sender.asked[-1]) == {f"ticket-{OK}", f"ticket-{DEAD}"}  # one batch
    [record] = [r for r in caplog.records if r.message == "push_receipts_checked"]
    counts = {key: record.__dict__[key] for key in ("checked", "dead", "resent")}
    assert counts == {"checked": 2, "dead": 1, "resent": 1}  # the sweep completed
    assert await ticket_ids(redis, prefix) == set()  # the completed tickets are deleted
    assert await device_tokens(db_session) == {BUSY, OK}  # the unrelated device is cleaned up
    assert set(queue.jobs) == {"push:quote:1"}
    await push(ctx, user, "quote:1", **QUOTE)  # the queued resend runs, still muted
    assert sent_to(sender) == {BUSY: 1, OK: 1, DEAD: 1}  # BUSY was never sent after the mute
    assert await statuses(redis, prefix, "quote:1") == ["failed", "failed"]


async def test_mute_keeps_dead_token_cleanup(
    ctx: dict[str, Any],
    db_session: AsyncSession,
    sender: FakeSender,
    redis: Redis,
    prefix: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = await make_user(db_session, "en", DEAD, BUSY)
    sender.errors = {DEAD: "DeviceNotRegistered", BUSY: RATE_LIMITED}
    forget = DeviceService.forget

    async def database_down(self: DeviceService, device_id: uuid.UUID) -> None:
        raise SQLAlchemyError("synthetic outage")

    monkeypatch.setattr(DeviceService, "forget", database_down)
    with pytest.raises(Retry):
        await push(ctx, user, "quote:1", **QUOTE)
    assert sorted(await statuses(redis, prefix, "quote:1")) == ["dead", "pending"]

    monkeypatch.setattr(DeviceService, "forget", forget)
    await set_preference(db_session, user, GROUP, False)
    await push({**ctx, "job_try": 2}, user, "quote:1", **QUOTE)  # done: no Retry

    assert sent_to(sender) == {DEAD: 1, BUSY: 1}  # the first run only
    assert await device_tokens(db_session) == {BUSY}  # the dead device is still deleted
    assert sorted(await statuses(redis, prefix, "quote:1")) == ["failed", "gone"]


@pytest.mark.parametrize("on_at_lookup", [True, False])
async def test_preference_change_mid_run_is_one_decision(
    on_at_lookup: bool,
    ctx: dict[str, Any],
    db_session: AsyncSession,
    sender: FakeSender,
    redis: Redis,
    prefix: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = await make_user(db_session, "en", BUSY, OK)
    await set_preference(db_session, user, GROUP, on_at_lookup)
    enabled = NotificationPreferenceService.enabled
    lookups: list[bool] = []

    async def then_flip(
        self: NotificationPreferenceService,
        user_id: uuid.UUID,
        group: PreferenceGroup,
        channel: Channel,
    ) -> bool:
        answer = await enabled(self, user_id, group, channel)
        lookups.append(answer)
        await set_preference(db_session, user, GROUP, not on_at_lookup)  # right after the read
        return answer

    monkeypatch.setattr(NotificationPreferenceService, "enabled", then_flip)
    await push(ctx, user, "quote:1", **QUOTE)

    assert lookups == [on_at_lookup]  # read once for the whole run
    if on_at_lookup:  # every device sent
        assert sent_to(sender) == {BUSY: 1, OK: 1}
        assert await statuses(redis, prefix, "quote:1") == ["accepted", "accepted"]
    else:  # every device muted
        assert sender.sent == []
        assert await statuses(redis, prefix, "quote:1") == ["failed", "failed"]
