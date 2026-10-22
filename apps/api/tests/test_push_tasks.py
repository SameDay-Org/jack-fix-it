"""The push worker tasks (D10.3, #54): a fake sender, real Redis under a unique prefix, and the
rolled-back test session. No network."""

import logging
import uuid
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import pytest
from arq import Retry
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.expo_push import PushMessage, PushUnavailableError, Receipt, Ticket
from app.modules.devices.models import Device, DevicePlatform
from app.modules.notifications.push_tasks import check_push_receipts, send_push
from app.modules.notifications.service import InvalidPushError
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from app.worker import WorkerSettings, every
from tests.conftest import make_settings

DEEP_LINK = f"/requests/{uuid.UUID(int=7)}"
PARAMS = {"public_code": "JF-000124"}
BACKOFF = 7  # not the default (30)
TICKET_TTL = 3_600


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
    return make_settings(push_retry_backoff_seconds=BACKOFF, push_ticket_ttl_seconds=TICKET_TTL)


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
def ctx(
    settings: Settings, db_session: AsyncSession, redis: Redis, prefix: str, sender: FakeSender
) -> dict[str, Any]:
    return {
        "settings": settings,
        "session_factory": sessions_of(db_session),
        "push_sender": sender,
        "redis": redis,
        "push_key_prefix": prefix,
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
        assert stored.decode() == str(devices[token])
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
    ctx["job_try"] = 3

    with pytest.raises(Retry) as retry:
        await push(ctx, user)

    assert retry.value.defer_score == BACKOFF * 3 * 1000  # ARQ keeps milliseconds
    # The claim was released, so the retry sends.
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
    assert send_push in WorkerSettings.functions
    [job] = WorkerSettings.cron_jobs
    assert job.coroutine is check_push_receipts
    assert every(15) == {0, 15, 30, 45}
    assert every(60) == {0}
