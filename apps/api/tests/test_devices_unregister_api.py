"""POST /v1/devices/unregister: a device removes its own push token with no session (#345)."""

import asyncio
import json
import logging
import re
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete, event, func, select, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession

from app.config import Settings
from app.middleware import REQUEST_ID_HEADER
from app.modules.auth import security
from app.modules.auth.dependencies import get_current_user, get_optional_user
from app.modules.devices.models import Device, DevicePlatform
from app.modules.devices.repository import DeviceRepository
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from app.rate_limit import get_rate_limiter
from tests.conftest import (
    LOCK_WAIT_DEADLINE_SECONDS,
    TEST_JWT_SECRET,
    Committed,
    InMemoryRateLimiter,
    backend_pid,
    make_settings,
)
from tests.test_auth_api import register as register_account
from tests.test_devices_api import (
    VALIDATION_ERROR,
    caller,
    devices,
    register,
    token,
    unregister,
    wait_until_blocking,
)

PATH = "/v1/devices/unregister"
IP_LIMIT = 8  # not the default (10), so the tests prove it comes from settings
NOW = 1_000.0
OTHER_IP = "203.0.113.7"
PROBE = "secret-probe-345"
RATE_LIMITED = {"error": {"code": "rate_limited", "message": "Too many requests. Try again later."}}


@pytest.fixture
def settings() -> Settings:
    return make_settings(auth_rate_limit_requests=IP_LIMIT)


@pytest.fixture(autouse=True)
def limiter(app: FastAPI) -> InMemoryRateLimiter:
    """One fixed window for the whole test, and its counters for the test to read."""
    fixed = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: fixed
    return fixed


async def unregister_without_session(
    client: httpx.AsyncClient, value: str, headers: dict[str, str] | None = None
) -> httpx.Response:
    return await client.post(PATH, json={"expo_push_token": value}, headers=headers)


def headers_of(response: httpx.Response) -> list[tuple[str, str]]:
    """Every response header, in order. The request id is unique to each request by design, so
    it counts by name only."""
    return [
        (name, "" if name == REQUEST_ID_HEADER.lower() else value)
        for name, value in response.headers.multi_items()
    ]


async def device_rows(session: AsyncSession) -> dict[str, tuple[Any, ...]]:
    """token -> every other column, as plain values (ORM rows would refresh in place)."""
    statement = select(
        Device.expo_push_token,
        Device.id,
        Device.user_id,
        Device.platform,
        Device.last_seen_at,
        Device.created_at,
        Device.updated_at,
    )
    return {row[0]: tuple(row[1:]) for row in (await session.execute(statement)).all()}


async def user_count(session: AsyncSession) -> int:
    return int(await session.scalar(select(func.count()).select_from(User)) or 0)


async def test_unregister_without_session_removes_the_row(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _, ana = await caller(db_session)
    await register(db_client, ana, token("ana"))
    assert set(await devices(db_session)) == {token("ana")}

    response = await unregister_without_session(db_client, token("ana"))

    assert response.status_code == 204
    assert response.content == b""
    assert "authorization" not in response.request.headers
    assert await devices(db_session) == {}


async def test_unregister_unknown_token_is_204_and_identical(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _, ana = await caller(db_session)
    await register(db_client, ana, token("known"))

    found = await unregister_without_session(db_client, token("known"))
    unknown = await unregister_without_session(db_client, token("never-registered"))
    already_gone = await unregister_without_session(db_client, token("known"))

    assert found.status_code == 204
    assert found.content == b""
    for response in (unknown, already_gone):
        assert response.status_code == found.status_code
        assert response.content == found.content
        assert headers_of(response) == headers_of(found)
    assert await devices(db_session) == {}


async def test_unregister_leaves_other_users_and_tokens_alone(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _, ana = await caller(db_session)
    _, bruno = await caller(db_session, UserRole.PRO)
    target = token("ana_phone")
    # Ana's other devices: one that a LIKE would match (_ is its wildcard), one that differs
    # only by case, and an unrelated one. Bruno's is another account's.
    for value in (target, token("anaXphone"), token("ANA_PHONE"), token("ana-tablet")):
        await register(db_client, ana, value)
    await register(db_client, bruno, token("bruno-phone"))
    before = await device_rows(db_session)
    users_before = await user_count(db_session)

    response = await unregister_without_session(db_client, target)

    assert response.status_code == 204
    after = await device_rows(db_session)
    assert len(before) == 5
    assert len(after) == 4
    # Every other row is the very row it was: same id, owner, platform and timestamps.
    assert after == {value: row for value, row in before.items() if value != target}
    assert await user_count(db_session) == users_before


def _body(value: object) -> bytes:
    return json.dumps(value).encode()


@pytest.mark.parametrize(
    "content",
    [
        _body({"expo_push_token": "ExponentPushToken[]"}),
        _body({"expo_push_token": "ExponentPushToken[test-1"}),
        _body({"expo_push_token": "PushToken[test-1]"}),
        _body({"expo_push_token": "ExponentPushToken[test 1]"}),
        _body({"expo_push_token": "ExponentPushToken[" + "a" * 201 + "]"}),
        _body({"expo_push_token": "ExponentPushToken[" + chr(0xFF41) * 3 + "]"}),
        _body({"expo_push_token": token(1) + "\n"}),
        _body({"expo_push_token": " " + token(1)}),
        _body({"expo_push_token": "%"}),
        _body({"expo_push_token": ""}),
        _body({"expo_push_token": None}),
        _body({"expo_push_token": 1}),
        _body({"expo_push_token": [token(1)]}),
        _body({"expo_push_token": token(1), "user_id": str(uuid.uuid4())}),
        _body({"expo_push_token": token(1), "platform": "ios"}),
        _body({"expo_push_tokens": [token(1)]}),
        _body({}),
        _body(None),
        _body([{"expo_push_token": token(1)}]),
        _body(token(1)),
        b"",
        b"{",
    ],
    ids=[
        "empty_token",
        "unclosed",
        "wrong_prefix",
        "space",
        "too_long",
        "fullwidth",
        "trailing_newline",
        "leading_space",
        "wildcard",
        "blank",
        "null_token",
        "number",
        "list_of_tokens",
        "extra_field",
        "registration_body",
        "wrong_field",
        "empty_object",
        "json_null",
        "json_array",
        "json_string",
        "no_body",
        "not_json",
    ],
)
async def test_unregister_rejects_malformed_extra_or_empty_body(
    db_client: httpx.AsyncClient, db_session: AsyncSession, content: bytes
) -> None:
    _, ana = await caller(db_session)
    await register(db_client, ana, token(1))

    response = await db_client.post(
        PATH, content=content, headers={"Content-Type": "application/json"}
    )

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    assert set(await devices(db_session)) == {token(1)}


async def test_unregister_ignores_a_bad_bearer(
    app: FastAPI, db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    ana_id, ana = await caller(db_session)
    _, bruno = await caller(db_session)
    _, agent = await caller(db_session, UserRole.AGENT)
    past = datetime.now(UTC) - timedelta(days=1)
    expired = security.create_access_token(
        user_id=ana_id, role=UserRole.CUSTOMER, secret=TEST_JWT_SECRET, ttl_seconds=60, now=past
    )
    forged = security.create_access_token(
        user_id=ana_id,
        role=UserRole.CUSTOMER,
        secret="another-secret-not-the-api-s-0123456789",
        ttl_seconds=900,
        now=datetime.now(UTC),
    )
    bearers = {
        "garbage": "Bearer not-a-jwt",
        "expired": f"Bearer {expired}",
        "forged": f"Bearer {forged}",
        "no_credentials": "Bearer",
        "another_scheme": "Basic dXNlcjpwYXNzd29yZA==",
        # Valid sessions of other people: the route reads no session, so neither changes
        # the answer. Staff would be 403 on the authenticated routes.
        "another_user": bruno["Authorization"],
        "staff": agent["Authorization"],
    }
    for name in bearers:
        await register(db_client, ana, token(name))
    # From here on, any auth dependency that runs is recorded.
    ran: list[str] = []

    async def record_current_user() -> None:
        ran.append("get_current_user")

    async def record_optional_user() -> None:
        ran.append("get_optional_user")

    app.dependency_overrides[get_current_user] = record_current_user
    app.dependency_overrides[get_optional_user] = record_optional_user

    responses = {
        name: await unregister_without_session(db_client, token(name), {"Authorization": bearer})
        for name, bearer in bearers.items()
    }

    assert {name: response.status_code for name, response in responses.items()} == dict.fromkeys(
        bearers, 204
    )
    assert all(response.content == b"" for response in responses.values())
    assert ran == []
    assert await devices(db_session) == {}


async def test_unregister_is_rate_limited_per_ip_not_per_token(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    settings: Settings,
    limiter: InMemoryRateLimiter,
) -> None:
    _, ana = await caller(db_session)
    await register(db_client, ana, token("kept"))
    # A different token each time: the count follows the client, not the token.
    for n in range(IP_LIMIT):
        assert (await unregister_without_session(db_client, token(n))).status_code == 204

    limited_unknown = await unregister_without_session(db_client, token("another"))
    limited_registered = await unregister_without_session(db_client, token("kept"))
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False, client=(OTHER_IP, 1))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as other_ip:
        # A token the first client already sent IP_LIMIT times over is not limited elsewhere.
        same_token_elsewhere = await unregister_without_session(other_ip, token(0))

    for response in (limited_unknown, limited_registered):
        assert response.status_code == 429
        assert response.json() == RATE_LIMITED
        assert response.headers["Retry-After"] == limited_unknown.headers["Retry-After"]
        assert int(response.headers["Retry-After"]) >= 1
    assert headers_of(limited_registered) == headers_of(limited_unknown)
    assert set(await devices(db_session)) == {token("kept")}  # a limited call removes nothing
    assert same_token_elsewhere.status_code == 204
    window = int(NOW // settings.auth_rate_limit_window_seconds)
    assert dict(limiter.counts) == {
        f"devices_unregister:127.0.0.1:{window}": IP_LIMIT + 2,
        f"devices_unregister:{OTHER_IP}:{window}": 1,
    }
    assert not [key for key in limiter.counts if "PushToken" in key or "test-" in key]


@contextmanager
def recorded_statements(session: AsyncSession) -> Iterator[list[str]]:
    """Every statement the session's engine runs meanwhile, savepoints included: under the
    rolled-back test session a commit is a RELEASE SAVEPOINT."""
    statements: list[str] = []
    engine = session.get_bind().engine

    def record(*args: Any) -> None:
        statement: str = args[2]
        statements.append(re.sub(r"sa_savepoint_\d+", "sa_savepoint", statement))

    event.listen(engine, "before_cursor_execute", record)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", record)


async def test_unregister_statement_count_is_equal_found_or_not(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _, ana = await caller(db_session)
    await register(db_client, ana, token("known"))

    await db_session.commit()  # each request below starts its own transaction
    with recorded_statements(db_session) as found:
        assert (await unregister_without_session(db_client, token("known"))).status_code == 204
    await db_session.commit()
    with recorded_statements(db_session) as unknown:
        assert (await unregister_without_session(db_client, token("nobody"))).status_code == 204

    assert await devices(db_session) == {}
    assert found == unknown
    assert len(found) == len(unknown) == 3
    begin, removal, commit = found
    assert begin == "SAVEPOINT sa_savepoint"
    # One DELETE keyed on the token alone: no read first, no owner, nothing returned.
    assert removal.startswith("DELETE FROM devices WHERE devices.expo_push_token = ")
    assert "user_id" not in removal
    assert "RETURNING" not in removal
    assert commit == "RELEASE SAVEPOINT sa_savepoint"


def everything_logged(caplog: pytest.LogCaptureFixture) -> str:
    """Each record as production prints it (JSON, extras and exception included), its plain
    message, and pytest's own rendering."""
    formatter = JsonFormatter()
    lines = [formatter.format(record) + record.getMessage() for record in caplog.records]
    return "\n".join([*lines, caplog.text])


async def test_unregister_never_logs_the_token(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    probe = token(PROBE)
    _, ana = await caller(db_session)
    await register(db_client, ana, probe)
    # What the failing DELETE raises, to prove the token really was in the error.
    raised: list[str] = []
    delete_by_token = DeviceRepository.delete_by_token

    async def delete_and_keep_the_error(self: DeviceRepository, value: str) -> bool:
        try:
            return await delete_by_token(self, value)
        except Exception as error:
            raised.append(str(error))
            raise

    monkeypatch.setattr(DeviceRepository, "delete_by_token", delete_and_keep_the_error)

    with caplog.at_level(logging.DEBUG):
        found = await unregister_without_session(db_client, probe)
        unknown = await unregister_without_session(db_client, probe)
        invalid = await db_client.post(PATH, json={"expo_push_token": probe, "extra": True})
        # The DELETE itself fails, with the token among its parameters: Postgres refuses any
        # write for the rest of the test's (rolled back) transaction. Set on the connection,
        # outside the session's savepoint, which would take the setting with it when released.
        await db_session.commit()
        connection = db_session.bind
        assert isinstance(connection, AsyncConnection)
        await connection.execute(text("SET TRANSACTION READ ONLY"))
        failed = await unregister_without_session(db_client, probe)

    assert [r.status_code for r in (found, unknown, invalid, failed)] == [204, 204, 422, 500]
    assert len(raised) == 1
    assert PROBE in raised[0]
    output = everything_logged(caplog)
    captured = capsys.readouterr()
    for text_seen in (output, captured.out, captured.err, invalid.text, failed.text):
        assert PROBE not in text_seen
        assert "PushToken[" not in text_seen
    events = [
        json.loads(JsonFormatter().format(record))
        for record in caplog.records
        if record.getMessage() == "device_unregistered_without_session"
    ]
    standard = {"timestamp", "level", "logger", "message", "request_id"}
    assert [{k: v for k, v in e.items() if k not in standard} for e in events] == [
        {"removed": True},
        {"removed": False},
    ]
    [error] = [r for r in caplog.records if r.getMessage() == "unhandled_error"]
    assert json.loads(JsonFormatter().format(error))["sqlstate"] == "25006"  # read-only


@pytest.mark.parametrize("first", ["register", "unregister"])
async def test_unregister_racing_register_does_not_deadlock(
    committed: Committed, monkeypatch: pytest.MonkeyPatch, first: str
) -> None:
    body = (await register_account(committed.client, email=committed.email)).json()
    user_id = uuid.UUID(body["user"]["id"])
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    value = token(f"race-{uuid.uuid4().hex}")
    async with committed.sessions() as session:
        session.add(
            Device(
                user_id=user_id,
                expo_push_token=value,
                platform=DevicePlatform.IOS,
                last_seen_at=datetime.now(UTC) - timedelta(days=1),
            )
        )
        await session.commit()
    # Whichever goes first writes the token's row, then keeps its transaction open until
    # Postgres reports another backend waiting on a lock it holds: the other request, at that
    # row. The other starts only once the row is written, so the order is the test's.
    wrote = asyncio.Event()

    async def hold(repository: DeviceRepository) -> None:
        wrote.set()
        holder = await backend_pid(repository._session)
        await wait_until_blocking(committed.sessions, holder=holder)

    upsert = DeviceRepository.upsert
    delete_by_token = DeviceRepository.delete_by_token

    async def upsert_then_hold(self: DeviceRepository, *args: Any) -> uuid.UUID:
        device_id = await upsert(self, *args)
        if first == "register":
            await hold(self)
        return device_id

    async def delete_then_hold(self: DeviceRepository, removed_token: str) -> bool:
        removed = await delete_by_token(self, removed_token)
        if first == "unregister":
            await hold(self)
        return removed

    monkeypatch.setattr(DeviceRepository, "upsert", upsert_then_hold)
    monkeypatch.setattr(DeviceRepository, "delete_by_token", delete_then_hold)

    async def registration() -> httpx.Response:
        if first != "register":
            await wrote.wait()
        return await register(committed.client, headers, value, "android")

    async def removal() -> httpx.Response:
        if first != "unregister":
            await wrote.wait()
        return await unregister_without_session(committed.client, value)

    try:
        # A deadlock is a 500 from the one Postgres kills (40P01); a hang ends here.
        async with asyncio.timeout(4 * LOCK_WAIT_DEADLINE_SECONDS):
            registered, removed = await asyncio.gather(registration(), removal())

        assert (registered.status_code, removed.status_code) == (204, 204)
        async with committed.sessions() as reader:
            rows = (
                await reader.execute(
                    select(Device.user_id, Device.platform).where(Device.expo_push_token == value)
                )
            ).all()
        # The one that waited commits last and decides: the delete after the registration
        # removes the device, the registration after the delete creates it again.
        expected = [] if first == "register" else [(user_id, DevicePlatform.ANDROID)]
        assert [tuple(row) for row in rows] == expected
    finally:
        async with committed.sessions() as session:
            await session.execute(delete(Device).where(Device.user_id == user_id))
            await session.commit()


async def test_authenticated_delete_still_works(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _, ana = await caller(db_session)
    _, bruno = await caller(db_session)
    _, agent = await caller(db_session, UserRole.AGENT)
    await register(db_client, ana, token("ana"))
    await register(db_client, bruno, token("bruno"))

    no_session = await unregister(db_client, {}, token("ana"))
    staff = await unregister(db_client, agent, token("ana"))
    not_mine = await unregister(db_client, bruno, token("ana"))
    unknown = await unregister(db_client, bruno, token("nobody"))
    assert set(await devices(db_session)) == {token("ana"), token("bruno")}
    mine = await unregister(db_client, ana, token("ana"))

    # Still a session's route, still scoped to the caller's own token.
    assert no_session.status_code == 401
    assert no_session.json()["error"]["code"] == "invalid_token"
    assert staff.status_code == 403
    for response in (not_mine, unknown, mine):
        assert response.status_code == 204
        assert response.content == b""
    assert set(await devices(db_session)) == {token("bruno")}


def test_openapi_documents_the_sessionless_unregister(app: FastAPI) -> None:
    schema = app.openapi()
    operation = schema["paths"][PATH]["post"]

    assert set(schema["paths"][PATH]) == {"post"}
    assert set(operation["responses"]) == {"204", "422", "429"}
    assert "security" not in operation
    assert "Retry-After" in operation["responses"]["429"]["headers"]
    body = operation["requestBody"]
    assert body["required"] is True
    assert body["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/DeviceRemoval"
    }
    # The authenticated routes keep their bearer.
    for method in ("put", "delete"):
        assert schema["paths"]["/v1/devices"][method]["security"]
