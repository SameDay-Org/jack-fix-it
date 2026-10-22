"""PUT and DELETE /v1/devices: the app's Expo push tokens (D10.3, #54)."""

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import delete, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.modules.auth import security
from app.modules.auth.models import RefreshToken
from app.modules.devices.models import Device, DevicePlatform
from app.modules.devices.repository import DeviceRepository
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from tests.conftest import (
    LOCK_WAIT_DEADLINE_SECONDS,
    TEST_JWT_SECRET,
    Committed,
    backend_pid,
    make_settings,
)
from tests.test_auth_api import register as register_account

MAX_DEVICES = 3  # not the default (10), so the tests prove it comes from settings
VALIDATION_ERROR = {"error": {"code": "validation_error", "message": "The request is invalid."}}


@pytest.fixture
def settings() -> Settings:
    return make_settings(push_max_devices_per_user=MAX_DEVICES)


def token(n: int | str) -> str:
    return f"ExponentPushToken[test-{n}]"


async def caller(
    session: AsyncSession, role: UserRole = UserRole.CUSTOMER
) -> tuple[uuid.UUID, dict[str, str]]:
    user = User(email=f"{role.value}-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=role)
    session.add(user)
    await session.flush()
    access = security.create_access_token(
        user_id=user.id, role=role, secret=TEST_JWT_SECRET, ttl_seconds=900, now=datetime.now(UTC)
    )
    return user.id, {"Authorization": f"Bearer {access}"}


async def register(
    client: httpx.AsyncClient, headers: dict[str, str], value: str, platform: str = "ios"
) -> httpx.Response:
    return await client.put(
        "/v1/devices", json={"expo_push_token": value, "platform": platform}, headers=headers
    )


async def unregister(
    client: httpx.AsyncClient, headers: dict[str, str], value: str
) -> httpx.Response:
    return await client.request(
        "DELETE", "/v1/devices", json={"expo_push_token": value}, headers=headers
    )


async def devices(session: AsyncSession) -> dict[str, Device]:
    statement = select(Device).execution_options(populate_existing=True)
    return {row.expo_push_token: row for row in (await session.scalars(statement)).all()}


async def test_register_upserts_by_token_and_reassigns_owner(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    ana_id, ana = await caller(db_session)
    bruno_id, bruno = await caller(db_session, UserRole.PRO)

    first = await register(db_client, ana, token(1), "ios")
    row = (await devices(db_session))[token(1)]
    first_seen, device_id = row.last_seen_at, row.id
    again = await register(db_client, ana, token(1), "android")
    moved = await register(db_client, bruno, token(1), "android")

    assert first.status_code == again.status_code == moved.status_code == 204
    assert first.content == b""
    rows = await devices(db_session)
    assert list(rows) == [token(1)]
    assert rows[token(1)].id == device_id  # one row, updated in place
    assert rows[token(1)].user_id == bruno_id != ana_id
    assert rows[token(1)].platform == "android"
    assert rows[token(1)].last_seen_at >= first_seen


@pytest.mark.parametrize(
    "body",
    [
        {"expo_push_token": "ExponentPushToken[]", "platform": "ios"},
        {"expo_push_token": "ExponentPushToken[abc", "platform": "ios"},
        {"expo_push_token": "PushToken[abc]", "platform": "ios"},
        {"expo_push_token": "ExponentPushToken[a b]", "platform": "ios"},
        {"expo_push_token": "ExponentPushToken[" + "a" * 201 + "]", "platform": "ios"},
        {"expo_push_token": "ExponentPushToken[" + chr(0xFF41) * 3 + "]", "platform": "ios"},
        {"expo_push_token": token(1), "platform": "windows"},
        {"expo_push_token": token(1), "platform": "ios", "user_id": str(uuid.uuid4())},
    ],
    ids=[
        "empty",
        "unclosed",
        "wrong_prefix",
        "space",
        "too_long",
        "fullwidth",
        "unknown_platform",
        "extra_field",
    ],
)
async def test_invalid_token_format_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, body: dict[str, str]
) -> None:
    _, headers = await caller(db_session)

    response = await db_client.put("/v1/devices", json=body, headers=headers)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    assert await devices(db_session) == {}


async def test_both_expo_token_prefixes_accepted(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _, headers = await caller(db_session)

    for value in ("ExponentPushToken[aB0_-]", "ExpoPushToken[aB0_-]"):
        assert (await register(db_client, headers, value)).status_code == 204


async def test_max_devices_drops_least_recent(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_id, headers = await caller(db_session)
    _, other = await caller(db_session)
    await register(db_client, other, token("other"))
    for n in range(MAX_DEVICES):
        await register(db_client, headers, token(n))
    # Seen at distinct times: device 1 is the oldest, then 0, then 2.
    base = datetime.now(UTC) - timedelta(days=1)
    for n, minutes in ((0, 2), (1, 1), (2, 3)):
        await db_session.execute(
            update(Device)
            .where(Device.expo_push_token == token(n))
            .values(last_seen_at=base + timedelta(minutes=minutes))
        )

    await register(db_client, headers, token("new"))

    mine = {t for t, row in (await devices(db_session)).items() if row.user_id == user_id}
    assert mine == {token(0), token(2), token("new")}
    assert token("other") in await devices(db_session)


async def test_delete_only_own_token_and_always_204(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _, ana = await caller(db_session)
    _, bruno = await caller(db_session)
    await register(db_client, ana, token("ana"))
    await register(db_client, bruno, token("bruno"))

    not_mine = await unregister(db_client, bruno, token("ana"))
    unknown = await unregister(db_client, bruno, token("nobody"))
    mine = await unregister(db_client, bruno, token("bruno"))

    for response in (not_mine, unknown, mine):
        assert response.status_code == 204
        assert response.content == b""
    assert set(await devices(db_session)) == {token("ana")}


@pytest.mark.parametrize("role", [UserRole.AGENT, UserRole.ADMIN])
async def test_staff_403(
    db_client: httpx.AsyncClient, db_session: AsyncSession, role: UserRole
) -> None:
    _, headers = await caller(db_session, role)

    for response in (
        await register(db_client, headers, token(1)),
        await unregister(db_client, headers, token(1)),
    ):
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "forbidden"
    assert await devices(db_session) == {}


async def test_unauthenticated_401(db_client: httpx.AsyncClient) -> None:
    for response in (
        await register(db_client, {}, token(1)),
        await unregister(db_client, {}, token(1)),
    ):
        assert response.status_code == 401


async def test_no_tokens_in_logs(
    db_client: httpx.AsyncClient, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    _, headers = await caller(db_session)

    with caplog.at_level(logging.DEBUG):
        await register(db_client, headers, token("secret-probe"))
        await unregister(db_client, headers, token("secret-probe"))

    output = "\n".join(JsonFormatter().format(record) for record in caplog.records)
    assert "secret-probe" not in output
    [registered] = [r for r in caplog.records if r.message == "device_registered"]
    payload = json.loads(JsonFormatter().format(registered))
    assert set(payload) - {"timestamp", "level", "logger", "message", "request_id"} == {
        "user_id",
        "device_id",
        "dropped",
    }


async def wait_until_blocking(
    sessions: async_sessionmaker[AsyncSession],
    *,
    holder: int,
    or_until: asyncio.Event | None = None,
) -> None:
    """Returns once Postgres reports some backend waiting on a lock `holder` holds, or once
    `or_until` is set (the other side got through without waiting)."""
    query = text(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity"
        " WHERE CAST(:holder AS integer) = ANY(pg_blocking_pids(pid)))"
    )
    async with sessions() as monitor:
        try:
            async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
                while not (or_until is not None and or_until.is_set()) and not (
                    await monitor.scalar(query, {"holder": holder})
                ):
                    pass
        except TimeoutError:
            pytest.fail(
                f"no backend waited on backend {holder} within {LOCK_WAIT_DEADLINE_SECONDS} s"
            )


async def test_concurrent_registrations_keep_the_cap(
    committed: Committed, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = (await register_account(committed.client, email=committed.email)).json()
    user_id = uuid.UUID(body["user"]["id"])
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    seen = datetime.now(UTC) - timedelta(days=1)
    async with committed.sessions() as session:
        session.add_all(
            Device(
                user_id=user_id,
                expo_push_token=token(f"old-{n}"),
                platform=DevicePlatform.IOS,
                last_seen_at=seen,
            )
            for n in range(MAX_DEVICES - 1)
        )
        await session.commit()
    # The first registration to prune keeps its transaction open until Postgres reports another
    # backend waiting on a lock it holds: the second registration, at the user's lock. Without
    # that lock the second never waits; it prunes against a snapshot missing the first's device,
    # and both commit one device over the cap.
    holding = False
    keep_most_recent = DeviceRepository.keep_most_recent

    async def prune_then_hold(self: DeviceRepository, owner_id: uuid.UUID, keep: int) -> int:
        nonlocal holding
        dropped = await keep_most_recent(self, owner_id, keep)
        if not holding:
            holding = True
            await wait_until_blocking(committed.sessions, holder=await backend_pid(self._session))
        return dropped

    monkeypatch.setattr(DeviceRepository, "keep_most_recent", prune_then_hold)
    try:
        responses = await asyncio.gather(
            register(committed.client, headers, token("new-1"), "android"),
            register(committed.client, headers, token("new-2"), "android"),
        )

        assert [r.status_code for r in responses] == [204, 204]
        async with committed.sessions() as reader:
            tokens = set(
                (
                    await reader.scalars(
                        select(Device.expo_push_token).where(Device.user_id == user_id)
                    )
                ).all()
            )
            assert len(tokens) == MAX_DEVICES
            assert {token("new-1"), token("new-2")} <= tokens
    finally:
        async with committed.sessions() as session:
            await session.execute(delete(Device).where(Device.user_id == user_id))
            await session.commit()


async def test_crossing_token_transfers_between_two_owners_do_not_deadlock(
    committed: Committed, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A and B each have MAX_DEVICES devices. A registers B's oldest token while B registers
    # A's oldest: each upsert takes a row of the other owner, then each prune deletes a row the
    # other holds. Without one lock order over both owners, Postgres kills one (40P01, a 500).
    emails = [committed.email, f"refresh-{uuid.uuid4().hex}@example.com"]
    bodies = [(await register_account(committed.client, email=e)).json() for e in emails]
    owners = [uuid.UUID(body["user"]["id"]) for body in bodies]
    moved = [token(f"move-{n}-{uuid.uuid4().hex}") for n in range(2)]
    async with committed.sessions() as session:
        for owner, oldest in zip(owners, moved, strict=True):
            session.add(
                Device(
                    user_id=owner,
                    expo_push_token=oldest,
                    platform=DevicePlatform.IOS,
                    last_seen_at=datetime.now(UTC) - timedelta(days=MAX_DEVICES),
                )
            )
            session.add_all(
                Device(
                    user_id=owner,
                    expo_push_token=token(f"keep-{uuid.uuid4().hex}"),
                    platform=DevicePlatform.IOS,
                    last_seen_at=datetime.now(UTC) - timedelta(days=n),
                )
                for n in range(1, MAX_DEVICES)
            )
        await session.commit()
    # The first upsert holds its transaction until the second upsert is done too (both then
    # prune: the deadlock) or Postgres reports the second waiting on it (serialized).
    upserts = 0
    second_upserted = asyncio.Event()
    upsert = DeviceRepository.upsert

    async def upsert_then_hold(self: DeviceRepository, *args: Any) -> uuid.UUID:
        nonlocal upserts
        device_id = await upsert(self, *args)
        upserts += 1
        if upserts == 1:
            holder = await backend_pid(self._session)
            await wait_until_blocking(committed.sessions, holder=holder, or_until=second_upserted)
        else:
            second_upserted.set()
        return device_id

    monkeypatch.setattr(DeviceRepository, "upsert", upsert_then_hold)
    # Both requests reach their first owner lock before either takes it, so the lock order
    # alone decides whether they queue (same first owner) or each holds what the other wants.
    first_locks = asyncio.Barrier(2)
    met: set[int] = set()
    lock_owner = DeviceRepository.lock_owner

    async def meet_then_lock(self: DeviceRepository, user_id: uuid.UUID) -> None:
        if id(self._session) not in met:
            met.add(id(self._session))
            async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
                await first_locks.wait()
        await lock_owner(self, user_id)

    monkeypatch.setattr(DeviceRepository, "lock_owner", meet_then_lock)
    try:
        responses = await asyncio.gather(
            *(
                register(committed.client, {"Authorization": f"Bearer {body['access_token']}"}, t)
                for body, t in zip(bodies, reversed(moved), strict=True)
            )
        )

        assert [r.status_code for r in responses] == [204, 204]
        async with committed.sessions() as reader:
            rows = (await reader.execute(select(Device.user_id, Device.expo_push_token))).all()
        mine = {owner: {t for user_id, t in rows if user_id == owner} for owner in owners}
        assert moved[1] in mine[owners[0]]  # A took B's token
        assert moved[0] in mine[owners[1]]  # and B took A's
        assert all(len(tokens) <= MAX_DEVICES for tokens in mine.values())
    finally:
        async with committed.sessions() as session:
            await session.execute(delete(Device).where(Device.user_id.in_(owners)))
            await session.execute(delete(RefreshToken).where(RefreshToken.user_id == owners[1]))
            await session.execute(delete(User).where(User.id == owners[1]))
            await session.commit()
