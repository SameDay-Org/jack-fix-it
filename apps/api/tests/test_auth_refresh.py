"""Refresh token rotation, reuse detection and logout over HTTP (D4.2 part 2, #116)."""

import asyncio
import hashlib
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import jwt
import pytest
from pydantic import SecretStr, ValidationError
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import AppEnv, Settings
from app.modules.auth import security
from app.modules.auth.models import RefreshToken
from app.modules.auth.repository import RefreshTokenRepository
from app.modules.auth.service import AuthConfig
from app.modules.users.models import User
from app.modules.users.service import UserService
from app.modules.users.types import UserStatus
from app.observability import JsonFormatter
from tests.conftest import (
    LOCK_WAIT_DEADLINE_SECONDS,
    TEST_EMAIL_SETTINGS,
    TEST_JWT_SECRET,
    TEST_RATE_LIMIT_SETTINGS,
    TEST_STORAGE_SETTINGS,
    TEST_TWILIO_SETTINGS,
    Committed,
    backend_pid,
    make_settings,
    wait_until_blocked,
)
from tests.test_auth_api import EMAIL, PASSWORD, get_user, login, me, register, set_status

# Not the default, so the tests prove the TTL comes from the setting.
REFRESH_TTL_SECONDS = 3_600

INVALID_REFRESH_TOKEN = {
    "error": {
        "code": "invalid_refresh_token",
        "message": "The refresh token is invalid or expired.",
    }
}


@pytest.fixture
def settings() -> Settings:
    # Grace window off: these tests present a rotated token right away to prove theft
    # detection (#116). The grace window (#152) has its own tests below, with it on.
    return make_settings(
        refresh_token_ttl_seconds=REFRESH_TTL_SECONDS, refresh_reuse_grace_seconds=0
    )


async def refresh(client: httpx.AsyncClient, token: str) -> httpx.Response:
    return await client.post(
        "/v1/auth/refresh",
        content=json.dumps({"refresh_token": token}),
        headers={"Content-Type": "application/json"},
    )


async def logout(client: httpx.AsyncClient, token: str) -> httpx.Response:
    return await client.post(
        "/v1/auth/logout",
        content=json.dumps({"refresh_token": token}),
        headers={"Content-Type": "application/json"},
    )


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def get_row(session: AsyncSession, token: str) -> RefreshToken:
    statement = (
        select(RefreshToken)
        .where(RefreshToken.token_hash == token_hash(token))
        .execution_options(populate_existing=True)
    )
    return (await session.scalars(statement)).one()


async def family_rows(session: AsyncSession, family_id: uuid.UUID) -> list[RefreshToken]:
    statement = (
        select(RefreshToken)
        .where(RefreshToken.family_id == family_id)
        .execution_options(populate_existing=True)
    )
    return list((await session.scalars(statement)).all())


def assert_invalid_refresh_token(response: httpx.Response) -> None:
    assert response.status_code == 401
    assert response.json() == INVALID_REFRESH_TOKEN
    assert "WWW-Authenticate" not in response.headers


# Refresh


async def test_refresh_rotates_token(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    registered = (await register(db_client)).json()

    response = await refresh(db_client, registered["refresh_token"])

    assert response.status_code == 200
    body = response.json()
    assert body["user"] == registered["user"]
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == 900
    assert body["refresh_token"] != registered["refresh_token"]
    assert body["access_token"] != registered["access_token"]
    claims = jwt.decode(body["access_token"], TEST_JWT_SECRET, algorithms=["HS256"])
    assert claims["sub"] == registered["user"]["id"]
    assert (await me(db_client, body["access_token"])).status_code == 200

    old = await get_row(db_session, registered["refresh_token"])
    new = await get_row(db_session, body["refresh_token"])
    assert old.revoked_at is not None
    assert old.replaced_by_id == new.id
    assert new.family_id == old.family_id
    assert new.user_id == old.user_id
    assert new.revoked_at is None
    assert new.replaced_by_id is None
    # The same `now` stamps the revocation and the new expiry.
    assert new.expires_at - old.revoked_at == timedelta(seconds=REFRESH_TTL_SECONDS)


async def test_old_refresh_token_cannot_be_used_twice(db_client: httpx.AsyncClient) -> None:
    token = (await register(db_client)).json()["refresh_token"]

    assert (await refresh(db_client, token)).status_code == 200
    assert_invalid_refresh_token(await refresh(db_client, token))


async def test_refresh_chain_keeps_one_family(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    tokens = [(await register(db_client)).json()["refresh_token"]]
    for _ in range(3):
        tokens.append((await refresh(db_client, tokens[-1])).json()["refresh_token"])

    rows = [await get_row(db_session, token) for token in tokens]
    assert len({row.family_id for row in rows}) == 1
    assert [row.replaced_by_id for row in rows] == [row.id for row in rows[1:]] + [None]
    assert [row.revoked_at is None for row in rows] == [False, False, False, True]


async def test_reuse_revokes_whole_family(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    token_a = (await register(db_client)).json()["refresh_token"]
    other_session = (await login(db_client)).json()["refresh_token"]
    token_b = (await refresh(db_client, token_a)).json()["refresh_token"]

    assert_invalid_refresh_token(await refresh(db_client, token_a))
    # The legitimate holder's newest token is gone too.
    assert_invalid_refresh_token(await refresh(db_client, token_b))

    family_id = (await get_row(db_session, token_a)).family_id
    rows = await family_rows(db_session, family_id)
    assert len(rows) == 2
    assert all(row.revoked_at is not None for row in rows)
    assert (await get_row(db_session, token_b)).replaced_by_id is None
    # Another login of the same user is another family, untouched.
    other = await get_row(db_session, other_session)
    assert other.family_id != family_id
    assert other.revoked_at is None
    assert (await refresh(db_client, other_session)).status_code == 200


async def test_reuse_log_has_ids_only(
    db_client: httpx.AsyncClient, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    token_a = (await register(db_client)).json()["refresh_token"]
    token_b = (await refresh(db_client, token_a)).json()["refresh_token"]
    caplog.clear()

    with caplog.at_level(logging.INFO):
        await refresh(db_client, token_a)

    row = await get_row(db_session, token_a)
    user = await get_user(db_session)
    [record] = [r for r in caplog.records if r.message == "auth_refresh_reuse_detected"]
    assert record.levelno == logging.WARNING
    formatter = JsonFormatter()
    payload = json.loads(formatter.format(record))
    assert payload["user_id"] == str(user.id)
    assert payload["family_id"] == str(row.family_id)
    assert set(payload) <= {"timestamp", "level", "logger", "message", "request_id"} | {
        "user_id",
        "family_id",
    }
    output = "\n".join(formatter.format(r) for r in caplog.records)
    for secret in (token_a, token_b, token_hash(token_a), token_hash(token_b), EMAIL, PASSWORD):
        assert secret not in output


@pytest.mark.parametrize(
    "kind",
    [
        "unknown",
        "expired",
        "empty",
        "blank",
        "malformed",
        "stored_hash",
        "lone_surrogate",
        "very_long",
    ],
)
async def test_refresh_rejects_unknown_expired_and_malformed(
    db_client: httpx.AsyncClient, db_session: AsyncSession, kind: str
) -> None:
    valid = (await register(db_client)).json()["refresh_token"]
    row = await get_row(db_session, valid)
    presented = {
        "unknown": security.new_refresh_token(),
        "expired": valid,
        "empty": "",
        "blank": "   ",
        "malformed": "not a refresh token",
        # The stored digest is not a token: it must not be accepted in place of one.
        "stored_hash": row.token_hash,
        "lone_surrogate": "\ud800",
        "very_long": "a" * 10_000,
    }[kind]
    if kind == "expired":
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await db_session.flush()

    assert_invalid_refresh_token(await refresh(db_client, presented))

    # Not a reuse, so nothing was revoked.
    assert (await get_row(db_session, valid)).revoked_at is None


async def test_refresh_rejects_token_revoked_by_logout(
    db_client: httpx.AsyncClient, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    token = (await register(db_client)).json()["refresh_token"]
    assert (await logout(db_client, token)).status_code == 204

    with caplog.at_level(logging.INFO):
        assert_invalid_refresh_token(await refresh(db_client, token))

    row = await get_row(db_session, token)
    assert row.revoked_at is not None
    assert row.replaced_by_id is None
    # Revoked by logout, never rotated: not reported as reuse.
    assert not any(r.message == "auth_refresh_reuse_detected" for r in caplog.records)


async def test_refresh_for_suspended_user_revokes_family(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    token_a = (await register(db_client)).json()["refresh_token"]
    token_b = (await refresh(db_client, token_a)).json()["refresh_token"]
    other_session = (await login(db_client)).json()["refresh_token"]
    await set_status(db_session, EMAIL, UserStatus.SUSPENDED)

    assert_invalid_refresh_token(await refresh(db_client, token_b))

    family_id = (await get_row(db_session, token_b)).family_id
    assert all(row.revoked_at is not None for row in await family_rows(db_session, family_id))
    assert (await get_row(db_session, other_session)).revoked_at is None


async def test_refresh_for_missing_user_revokes_family(
    db_client: httpx.AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = (await register(db_client)).json()["refresh_token"]

    async def no_user(self: UserService, user_id: uuid.UUID) -> None:
        return None

    monkeypatch.setattr(UserService, "get_by_id", no_user)

    assert_invalid_refresh_token(await refresh(db_client, token))
    assert (await get_row(db_session, token)).revoked_at is not None


async def committed_family(committed: Committed, token: str) -> list[RefreshToken]:
    async with committed.sessions() as session:
        family_id = (await get_row(session, token)).family_id
        return await family_rows(session, family_id)


async def test_concurrent_refresh_only_one_succeeds(
    committed: Committed, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = committed.client
    token = (await register(client, email=committed.email)).json()["refresh_token"]
    # Each request publishes its backend pid. The first one to get the token's locks keeps
    # its transaction open until Postgres reports the other one waiting on them, so the two
    # reads truly overlap; the lock decides who wins.
    pids: list[int] = []
    both_known = asyncio.Barrier(2)
    first_holder = asyncio.Event()
    read_for_update = RefreshTokenRepository.get_by_hash_for_update

    async def read_concurrently(
        self: RefreshTokenRepository, token_hash: str
    ) -> RefreshToken | None:
        own_pid = await backend_pid(self._session)
        pids.append(own_pid)
        async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
            await both_known.wait()
        row = await read_for_update(self, token_hash)
        if not first_holder.is_set():
            first_holder.set()
            [other_pid] = [pid for pid in pids if pid != own_pid]
            await wait_until_blocked(committed.sessions, waiter=other_pid, holder=own_pid)
        return row

    monkeypatch.setattr(RefreshTokenRepository, "get_by_hash_for_update", read_concurrently)

    responses = await asyncio.gather(refresh(client, token), refresh(client, token))

    assert sorted(response.status_code for response in responses) == [200, 401]
    [winner] = [response for response in responses if response.status_code == 200]
    [loser] = [response for response in responses if response.status_code == 401]
    assert_invalid_refresh_token(loser)
    # The loser saw a rotated token: reuse, so the winner's new token was revoked as well.
    rows = await committed_family(committed, token)
    assert len(rows) == 2
    assert all(row.revoked_at is not None for row in rows)
    monkeypatch.undo()
    assert_invalid_refresh_token(await refresh(client, winner.json()["refresh_token"]))


@pytest.mark.parametrize("stale_use", ["reuse", "logout"])
async def test_revocation_during_refresh_of_newest_token_catches_its_replacement(
    committed: Committed, monkeypatch: pytest.MonkeyPatch, stale_use: str
) -> None:
    client = committed.client
    token_a = (await register(client, email=committed.email)).json()["refresh_token"]
    token_b = (await refresh(client, token_a)).json()["refresh_token"]
    # The refresh of B inserts C, then keeps its transaction open until Postgres reports the
    # request that presents the stale token A waiting on a lock the refresh holds; only then
    # does it commit. With the family lock that wait is on the family; without it, on B's row
    # during the revocation UPDATE, which then misses C.
    holder_pid: list[int] = []
    stale_pid: list[int] = []
    inserted = asyncio.Event()
    stale_ready = asyncio.Event()
    add = RefreshTokenRepository.add
    read_for_update = RefreshTokenRepository.get_by_hash_for_update

    async def add_then_hold(self: RefreshTokenRepository, token: RefreshToken) -> RefreshToken:
        row = await add(self, token)
        holder_pid.append(await backend_pid(self._session))
        inserted.set()
        async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
            await stale_ready.wait()
        await wait_until_blocked(committed.sessions, waiter=stale_pid[0], holder=holder_pid[0])
        return row

    async def read_after_insert(
        self: RefreshTokenRepository, token_hash: str
    ) -> RefreshToken | None:
        if token_hash == security.hash_refresh_token(token_a):
            async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
                await inserted.wait()
            stale_pid.append(await backend_pid(self._session))
            stale_ready.set()
        return await read_for_update(self, token_hash)

    monkeypatch.setattr(RefreshTokenRepository, "add", add_then_hold)
    monkeypatch.setattr(RefreshTokenRepository, "get_by_hash_for_update", read_after_insert)
    stale = refresh(client, token_a) if stale_use == "reuse" else logout(client, token_a)

    rotated, stale_response = await asyncio.gather(refresh(client, token_b), stale)

    assert rotated.status_code == 200
    assert stale_response.status_code == (401 if stale_use == "reuse" else 204)
    rows = await committed_family(committed, token_a)
    assert len(rows) == 3
    assert all(row.revoked_at is not None for row in rows)
    monkeypatch.undo()
    assert_invalid_refresh_token(await refresh(client, rotated.json()["refresh_token"]))


@pytest.mark.parametrize("cause", ["reuse", "suspended"])
async def test_failed_refresh_still_commits_family_revocation(
    committed: Committed, cause: str
) -> None:
    client = committed.client
    token = (await register(client, email=committed.email)).json()["refresh_token"]
    if cause == "reuse":
        assert (await refresh(client, token)).status_code == 200
    else:
        async with committed.sessions() as session:
            await session.execute(
                update(User)
                .where(User.email == committed.email)
                .values(status=UserStatus.SUSPENDED)
            )
            await session.commit()

    assert_invalid_refresh_token(await refresh(client, token))

    rows = await committed_family(committed, token)
    assert rows
    assert all(row.revoked_at is not None for row in rows)


# Logout


async def test_logout_revokes_family_and_returns_204(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    registered = (await register(db_client)).json()
    token_b = (await refresh(db_client, registered["refresh_token"])).json()["refresh_token"]
    other_session = (await login(db_client)).json()["refresh_token"]

    response = await logout(db_client, token_b)

    assert response.status_code == 204
    assert response.content == b""
    family_id = (await get_row(db_session, token_b)).family_id
    assert all(row.revoked_at is not None for row in await family_rows(db_session, family_id))
    assert_invalid_refresh_token(await refresh(db_client, token_b))
    assert (await get_row(db_session, other_session)).revoked_at is None
    # The access token is not revoked on the server; it runs until it expires.
    assert (await me(db_client, registered["access_token"])).status_code == 200


@pytest.mark.parametrize(
    "kind", ["unknown", "expired", "revoked", "rotated", "empty", "malformed", "lone_surrogate"]
)
async def test_logout_unknown_or_revoked_token_still_204(
    db_client: httpx.AsyncClient, db_session: AsyncSession, kind: str
) -> None:
    token = (await register(db_client)).json()["refresh_token"]
    presented = {
        "unknown": security.new_refresh_token(),
        "empty": "",
        "malformed": "not a refresh token",
        "lone_surrogate": "\ud800",
    }.get(kind, token)
    if kind == "expired":
        (await get_row(db_session, token)).expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await db_session.flush()
    elif kind == "revoked":
        await logout(db_client, token)
    elif kind == "rotated":
        await refresh(db_client, token)

    response = await logout(db_client, presented)

    assert response.status_code == 204
    assert response.content == b""


async def test_logout_and_refresh_cannot_touch_another_users_family(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    ana = (await register(db_client)).json()
    bruno = (await register(db_client, email="bruno@example.com", role="pro")).json()
    ana_b = (await refresh(db_client, ana["refresh_token"])).json()

    # Ana's tokens act on Ana's family only: a reuse, then a logout.
    assert ana_b["user"] == ana["user"]
    assert_invalid_refresh_token(await refresh(db_client, ana["refresh_token"]))
    assert (await logout(db_client, ana_b["refresh_token"])).status_code == 204

    bruno_row = await get_row(db_session, bruno["refresh_token"])
    assert bruno_row.revoked_at is None
    assert bruno_row.replaced_by_id is None
    bruno_refreshed = await refresh(db_client, bruno["refresh_token"])
    assert bruno_refreshed.status_code == 200
    assert bruno_refreshed.json()["user"] == bruno["user"]


async def test_responses_never_contain_token_hash(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    token_a = (await register(db_client)).json()["refresh_token"]
    responses = [await refresh(db_client, token_a)]
    token_b = responses[0].json()["refresh_token"]
    responses.append(await refresh(db_client, token_a))
    responses.append(await refresh(db_client, token_b))
    responses.append(await logout(db_client, token_b))
    responses.append(await refresh(db_client, security.new_refresh_token()))

    hashes = [row.token_hash for row in (await db_session.scalars(select(RefreshToken))).all()]
    assert hashes
    for response in responses:
        assert "token_hash" not in response.text
        for stored in hashes:
            assert stored not in response.text
        if response.status_code != 200:
            assert token_a not in response.text
            assert token_b not in response.text


# Grace window (#152): a retried refresh after a lost response gets the same successor.

GRACE_SECONDS = 60  # not the default (30), so the tests prove it comes from the setting
GRACE_ON = [
    make_settings(
        refresh_token_ttl_seconds=REFRESH_TTL_SECONDS, refresh_reuse_grace_seconds=GRACE_SECONDS
    )
]
# Fixture values only.
ROTATION_KEY_A = "test-rotation-key-a-not-real-0123456789"
ROTATION_KEY_B = "test-rotation-key-b-not-real-0123456789"


async def family_count(session: AsyncSession, family_id: uuid.UUID) -> int:
    statement = (
        select(func.count()).select_from(RefreshToken).where(RefreshToken.family_id == family_id)
    )
    return (await session.scalar(statement)) or 0


async def rotated_before_grace(session: AsyncSession, token: str) -> None:
    """Moves the rotation of `token` just outside the grace window, without waiting."""
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.token_hash == token_hash(token))
        .values(revoked_at=datetime.now(UTC) - timedelta(seconds=GRACE_SECONDS + 1))
    )


@pytest.mark.parametrize("settings", GRACE_ON)
async def test_retry_within_grace_returns_same_successor(
    db_client: httpx.AsyncClient, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    first = (await register(db_client)).json()["refresh_token"]
    rotated = (await refresh(db_client, first)).json()
    successor_row = await get_row(db_session, rotated["refresh_token"])
    expires_at = successor_row.expires_at

    with caplog.at_level(logging.INFO):
        retried = await refresh(db_client, first)

    assert retried.status_code == 200
    assert retried.json()["refresh_token"] == rotated["refresh_token"]
    assert retried.json()["access_token"] != rotated["access_token"]
    assert (await me(db_client, retried.json()["access_token"])).status_code == 200
    # No new row, no new expiry; the successor is still the live token of the family.
    assert await family_count(db_session, successor_row.family_id) == 2
    successor_row = await get_row(db_session, rotated["refresh_token"])
    assert successor_row.expires_at == expires_at
    assert successor_row.revoked_at is None
    [record] = [r for r in caplog.records if r.message == "auth_refresh_grace_replay"]
    payload = json.loads(JsonFormatter().format(record))
    assert set(payload) - {"timestamp", "level", "logger", "message", "request_id"} == {
        "user_id",
        "family_id",
    }
    assert not [r for r in caplog.records if r.message == "auth_refresh_reuse_detected"]
    # The successor keeps working normally.
    assert (await refresh(db_client, rotated["refresh_token"])).status_code == 200


@pytest.mark.parametrize("settings", GRACE_ON)
async def test_retry_after_grace_revokes_family(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    first = (await register(db_client)).json()["refresh_token"]
    successor = (await refresh(db_client, first)).json()["refresh_token"]
    await rotated_before_grace(db_session, first)

    assert_invalid_refresh_token(await refresh(db_client, first))

    assert (await get_row(db_session, successor)).revoked_at is not None
    assert_invalid_refresh_token(await refresh(db_client, successor))


@pytest.mark.parametrize("settings", GRACE_ON)
async def test_retry_after_successor_used_revokes_family(
    db_client: httpx.AsyncClient, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    first = (await register(db_client)).json()["refresh_token"]
    second = (await refresh(db_client, first)).json()["refresh_token"]
    third = (await refresh(db_client, second)).json()["refresh_token"]

    with caplog.at_level(logging.INFO):
        assert_invalid_refresh_token(await refresh(db_client, first))

    assert (await get_row(db_session, third)).revoked_at is not None
    assert [r for r in caplog.records if r.message == "auth_refresh_reuse_detected"]
    assert not [r for r in caplog.records if r.message == "auth_refresh_grace_replay"]


@pytest.mark.parametrize("settings", GRACE_ON)
async def test_retry_after_logout_is_401(db_client: httpx.AsyncClient) -> None:
    first = (await register(db_client)).json()["refresh_token"]
    successor = (await refresh(db_client, first)).json()["refresh_token"]
    assert (await logout(db_client, successor)).status_code == 204

    assert_invalid_refresh_token(await refresh(db_client, first))
    # A token revoked by logout itself (replaced_by_id NULL) has no successor either.
    other = (await login(db_client)).json()["refresh_token"]
    assert (await logout(db_client, other)).status_code == 204
    assert_invalid_refresh_token(await refresh(db_client, other))


@pytest.mark.parametrize("settings", GRACE_ON)
async def test_retry_after_password_reset_is_401(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    registered = (await register(db_client)).json()
    first = registered["refresh_token"]
    await refresh(db_client, first)
    # What a successful password reset does to the sessions (#27).
    await RefreshTokenRepository(db_session).revoke_all_for_user(
        uuid.UUID(registered["user"]["id"]), datetime.now(UTC)
    )

    assert_invalid_refresh_token(await refresh(db_client, first))


@pytest.mark.parametrize("settings", GRACE_ON)
@pytest.mark.parametrize("already_rotated", [True, False], ids=["retries", "first_refreshes"])
async def test_concurrent_retries_within_grace_both_get_same_successor(
    committed: Committed, monkeypatch: pytest.MonkeyPatch, already_rotated: bool
) -> None:
    # Two refreshes of one token at once. The first to get the family lock keeps its
    # transaction open until Postgres reports the other waiting on it, so they truly overlap;
    # the lock serializes them, and both get the same successor.
    client = committed.client
    token = (await register(client, email=committed.email)).json()["refresh_token"]
    expected = None
    if already_rotated:
        expected = (await refresh(client, token)).json()["refresh_token"]
    pids: list[int] = []
    both_known = asyncio.Barrier(2)
    first_holder = asyncio.Event()
    read_for_update = RefreshTokenRepository.get_by_hash_for_update

    async def read_concurrently(self: RefreshTokenRepository, hashed: str) -> RefreshToken | None:
        own_pid = await backend_pid(self._session)
        pids.append(own_pid)
        async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
            await both_known.wait()
        row = await read_for_update(self, hashed)
        if not first_holder.is_set():
            first_holder.set()
            [other_pid] = [pid for pid in pids if pid != own_pid]
            await wait_until_blocked(committed.sessions, waiter=other_pid, holder=own_pid)
        return row

    monkeypatch.setattr(RefreshTokenRepository, "get_by_hash_for_update", read_concurrently)

    responses = await asyncio.gather(refresh(client, token), refresh(client, token))

    assert [response.status_code for response in responses] == [200, 200]
    successors = {response.json()["refresh_token"] for response in responses}
    assert len(successors) == 1
    if expected is not None:
        assert successors == {expected}
    rows = await committed_family(committed, token)
    assert len(rows) == 2
    assert sum(row.revoked_at is None for row in rows) == 1


def test_successor_is_deterministic_and_secret_dependent() -> None:
    token = security.new_refresh_token()

    successor = security.successor_refresh_token(token, ROTATION_KEY_A)

    assert successor == security.successor_refresh_token(token, ROTATION_KEY_A)
    assert successor != security.successor_refresh_token(token, ROTATION_KEY_B)
    assert successor != security.successor_refresh_token(token + "x", ROTATION_KEY_A)
    assert successor != token
    # The same length class as a random token: 32 bytes, base64url without padding.
    assert len(successor) == len(token) == 43
    assert set(successor) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")


@pytest.mark.parametrize(
    "settings",
    [
        make_settings(
            refresh_token_ttl_seconds=REFRESH_TTL_SECONDS,
            refresh_reuse_grace_seconds=GRACE_SECONDS,
            refresh_rotation_secret=ROTATION_KEY_A,
        )
    ],
)
async def test_rotation_uses_the_configured_secret(db_client: httpx.AsyncClient) -> None:
    first = (await register(db_client)).json()["refresh_token"]

    successor = (await refresh(db_client, first)).json()["refresh_token"]

    assert successor == security.successor_refresh_token(first, ROTATION_KEY_A)
    assert successor != security.successor_refresh_token(first, security.DEVELOPMENT_ROTATION_KEY)


@pytest.mark.parametrize("settings", GRACE_ON)
async def test_first_token_of_family_is_random(
    db_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    issued: list[str] = []
    random_token = security.new_refresh_token

    def spy() -> str:
        issued.append(random_token())
        return issued[-1]

    monkeypatch.setattr(security, "new_refresh_token", spy)

    registered = (await register(db_client)).json()["refresh_token"]
    logged_in = (await login(db_client)).json()["refresh_token"]
    rotated = (await refresh(db_client, logged_in)).json()["refresh_token"]

    # Login and registration take a random token; a rotation derives its successor instead.
    assert issued == [registered, logged_in]
    assert registered != logged_in
    assert rotated == security.successor_refresh_token(logged_in, security.DEVELOPMENT_ROTATION_KEY)


@pytest.mark.parametrize("app_env", ["staging", "production"])
def test_secret_required_when_deployed(app_env: AppEnv) -> None:
    deployed: dict[str, object] = {
        "app_env": app_env,
        "jwt_secret": "s" * 32,
        **TEST_STORAGE_SETTINGS,
        **TEST_TWILIO_SETTINGS,
        **TEST_RATE_LIMIT_SETTINGS,
        **TEST_EMAIL_SETTINGS,
    }
    short = "r" * 31

    for value in (None, "", short):
        with pytest.raises(ValidationError, match="REFRESH_ROTATION_SECRET") as error:
            make_settings(**deployed, refresh_rotation_secret=value)
        assert short not in str(error.value)
    settings = make_settings(**deployed, refresh_rotation_secret=ROTATION_KEY_A)
    assert AuthConfig.from_settings(settings).refresh_rotation_key == ROTATION_KEY_A
    # A hand-built Settings that skips validation must not reach the development key either.
    unvalidated = Settings.model_construct(
        app_env=app_env, jwt_secret=SecretStr("s" * 32), refresh_rotation_secret=None
    )
    with pytest.raises(RuntimeError, match="REFRESH_ROTATION_SECRET"):
        AuthConfig.from_settings(unvalidated)


@pytest.mark.parametrize("app_env", ["development", "test"])
def test_development_key_only_without_secret(app_env: str) -> None:
    unset = AuthConfig.from_settings(make_settings(app_env=app_env))
    configured = AuthConfig.from_settings(
        make_settings(app_env=app_env, refresh_rotation_secret=ROTATION_KEY_A)
    )

    assert unset.refresh_rotation_key == security.DEVELOPMENT_ROTATION_KEY
    assert configured.refresh_rotation_key == ROTATION_KEY_A
    assert ROTATION_KEY_A not in repr(make_settings(refresh_rotation_secret=ROTATION_KEY_A))


@pytest.mark.parametrize("settings", GRACE_ON)
async def test_no_tokens_in_logs(
    db_client: httpx.AsyncClient, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG):
        first = (await register(db_client)).json()["refresh_token"]
        second = (await refresh(db_client, first)).json()["refresh_token"]
        await refresh(db_client, first)  # grace replay
        third = (await refresh(db_client, second)).json()["refresh_token"]
        await refresh(db_client, first)  # reuse: the family is revoked

    output = "\n".join(JsonFormatter().format(record) for record in caplog.records)
    for token in (first, second, third):
        assert token not in output
        assert token_hash(token) not in output
    messages = {record.message for record in caplog.records}
    assert {"auth_refresh_grace_replay", "auth_refresh_reuse_detected"} <= messages


@pytest.mark.parametrize("settings", GRACE_ON)
@pytest.mark.parametrize("case", ["successor_expired", "user_suspended", "successor_not_derived"])
async def test_no_replay_without_a_live_rederivable_successor(
    db_client: httpx.AsyncClient, db_session: AsyncSession, case: str
) -> None:
    registered = (await register(db_client)).json()
    first = registered["refresh_token"]
    successor = (await refresh(db_client, first)).json()["refresh_token"]
    if case == "successor_expired":
        await db_session.execute(
            update(RefreshToken)
            .where(RefreshToken.token_hash == token_hash(successor))
            .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
    elif case == "user_suspended":
        await set_status(db_session, EMAIL, UserStatus.SUSPENDED)
    else:
        # A successor issued before #152 was random: the old token cannot re-derive it.
        await db_session.execute(
            update(RefreshToken)
            .where(RefreshToken.token_hash == token_hash(successor))
            .values(token_hash=token_hash(security.new_refresh_token()))
        )

    assert_invalid_refresh_token(await refresh(db_client, first))
