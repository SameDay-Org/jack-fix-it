"""Refresh token rotation, reuse detection and logout over HTTP (D4.2 part 2, #116)."""

import asyncio
import hashlib
import json
import logging
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx
import jwt
import pytest
from fastapi import FastAPI
from sqlalchemy import URL, delete, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import Settings
from app.modules.auth import security
from app.modules.auth.models import RefreshToken
from app.modules.auth.repository import RefreshTokenRepository
from app.modules.users.models import User
from app.modules.users.service import UserService
from app.modules.users.types import UserStatus
from app.observability import JsonFormatter
from tests.conftest import TEST_JWT_SECRET, make_settings
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
    return make_settings(refresh_token_ttl_seconds=REFRESH_TTL_SECONDS)


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


# Real commits on separate connections: the rolled-back db_session cannot show either.


@dataclass(frozen=True)
class Committed:
    client: httpx.AsyncClient
    sessions: async_sessionmaker[AsyncSession]
    email: str


@pytest.fixture
async def committed(app: FastAPI, test_database_url: URL) -> AsyncIterator[Committed]:
    """The app with one real session per request on the test database; rows are committed.

    Uses its own user and deletes it, with its tokens, afterwards.
    """
    engine = create_async_engine(test_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    app.state.session_factory = sessions
    email = f"refresh-{uuid.uuid4().hex}@example.com"
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            yield Committed(client=client, sessions=sessions, email=email)
    finally:
        async with sessions() as session:
            user_ids = select(User.id).where(User.email == email).scalar_subquery()
            await session.execute(delete(RefreshToken).where(RefreshToken.user_id.in_(user_ids)))
            await session.execute(delete(User).where(User.email == email))
            await session.commit()
        await engine.dispose()


async def committed_family(committed: Committed, token: str) -> list[RefreshToken]:
    async with committed.sessions() as session:
        family_id = (await get_row(session, token)).family_id
        return await family_rows(session, family_id)


async def test_concurrent_refresh_only_one_succeeds(
    committed: Committed, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = committed.client
    token = (await register(client, email=committed.email)).json()["refresh_token"]
    # Both requests read the token at the same moment; the row lock decides who wins.
    barrier = asyncio.Barrier(2)
    read_for_update = RefreshTokenRepository.get_by_hash_for_update

    async def read_together(self: RefreshTokenRepository, token_hash: str) -> RefreshToken | None:
        async with asyncio.timeout(10):
            await barrier.wait()
        return await read_for_update(self, token_hash)

    monkeypatch.setattr(RefreshTokenRepository, "get_by_hash_for_update", read_together)

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


async def wait_for_lock_waiter(sessions: async_sessionmaker[AsyncSession]) -> None:
    """Returns once some connection to the test database is waiting on a lock."""
    query = text(
        "SELECT count(*) FROM pg_stat_activity"
        " WHERE datname = current_database() AND wait_event_type = 'Lock'"
    )
    async with asyncio.timeout(10):
        while True:
            async with sessions() as session:
                if await session.scalar(query):
                    return
            await asyncio.sleep(0.01)


@pytest.mark.parametrize("stale_use", ["reuse", "logout"])
async def test_revocation_during_refresh_of_newest_token_catches_its_replacement(
    committed: Committed, monkeypatch: pytest.MonkeyPatch, stale_use: str
) -> None:
    client = committed.client
    token_a = (await register(client, email=committed.email)).json()["refresh_token"]
    token_b = (await refresh(client, token_a)).json()["refresh_token"]
    # The refresh of B inserts C, then holds its transaction open until the request that
    # presents the stale token A is blocked; only then does it commit.
    inserted = asyncio.Event()
    add = RefreshTokenRepository.add
    read_for_update = RefreshTokenRepository.get_by_hash_for_update

    async def add_then_hold(self: RefreshTokenRepository, token: RefreshToken) -> RefreshToken:
        row = await add(self, token)
        inserted.set()
        await wait_for_lock_waiter(committed.sessions)
        return row

    async def read_after_insert(
        self: RefreshTokenRepository, token_hash: str
    ) -> RefreshToken | None:
        if token_hash == security.hash_refresh_token(token_a):
            async with asyncio.timeout(10):
                await inserted.wait()
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
