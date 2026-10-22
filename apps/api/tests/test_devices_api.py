"""PUT and DELETE /v1/devices: the app's Expo push tokens (D10.3, #54)."""

import json
import logging
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.auth import security
from app.modules.devices.models import Device
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from tests.conftest import TEST_JWT_SECRET, make_settings

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
