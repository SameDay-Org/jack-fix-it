"""An access token names its refresh family, the session (`sid`), and is refused at the next
request once that session is revoked, not when it expires (#161).

Committed sessions: each request is its own transaction on its own connection, as in
production, so a revocation is seen only once it is committed.
"""

import logging
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import jwt
import pytest
from sqlalchemy import event, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.modules.auth import security
from app.modules.auth.models import RefreshToken
from app.modules.users.models import User
from app.modules.users.service import UserService
from app.modules.users.types import UserRole, UserStatus
from tests.conftest import TEST_JWT_SECRET, Committed
from tests.test_auth_api import assert_invalid_token, login, me, register
from tests.test_auth_refresh import get_row, logout, refresh

ACCESS_TTL_SECONDS = 900


def sid_of(access_token: str) -> uuid.UUID:
    claims = jwt.decode(access_token, TEST_JWT_SECRET, algorithms=[security.JWT_ALGORITHM])
    return uuid.UUID(claims["sid"])


async def family_of(committed: Committed, refresh_token: str) -> uuid.UUID:
    async with committed.sessions() as session:
        return (await get_row(session, refresh_token)).family_id


async def assert_signed_in(client: httpx.AsyncClient, access_token: str) -> None:
    response = await me(client, access_token)
    assert response.status_code == 200, response.text


async def assert_refused(client: httpx.AsyncClient, access_token: str) -> None:
    assert_invalid_token(await me(client, access_token))


def legacy_access_token(user_id: str, *, issued: datetime) -> str:
    """A token as the API issued it before #161: the same claims, no `sid`."""
    issued_at = int(issued.timestamp())
    claims = {
        "sub": user_id,
        "role": UserRole.CUSTOMER.value,
        "iat": issued_at,
        "exp": issued_at + ACCESS_TTL_SECONDS,
        "jti": uuid.uuid4().hex,
        "typ": security.ACCESS_TOKEN_TYPE,
    }
    return jwt.encode(claims, TEST_JWT_SECRET, algorithm=security.JWT_ALGORITHM)


def signed(claims: dict[str, Any]) -> str:
    """A token signed with the API's own key: what a bug minting a wrong `sid` would issue."""
    now = int(datetime.now(UTC).timestamp())
    base = {"iat": now, "exp": now + ACCESS_TTL_SECONDS, "jti": uuid.uuid4().hex}
    base["typ"] = security.ACCESS_TOKEN_TYPE
    return jwt.encode({**base, **claims}, TEST_JWT_SECRET, algorithm=security.JWT_ALGORITHM)


async def test_every_access_token_names_the_family_of_its_refresh_token(
    committed: Committed,
) -> None:
    client = committed.client
    registered = (await register(client, email=committed.email)).json()
    rotated = (await refresh(client, registered["refresh_token"])).json()
    # Within the grace window, with the successor unused: the lost response again (#152).
    replayed = (await refresh(client, registered["refresh_token"])).json()
    logged_in = (await login(client, email=committed.email)).json()

    family = await family_of(committed, registered["refresh_token"])
    assert replayed["refresh_token"] == rotated["refresh_token"]
    for response in (registered, rotated, replayed):
        assert sid_of(response["access_token"]) == family
    assert sid_of(logged_in["access_token"]) == await family_of(
        committed, logged_in["refresh_token"]
    )
    assert sid_of(logged_in["access_token"]) != family


async def test_logout_refuses_the_session_s_access_tokens_at_the_next_request(
    committed: Committed, caplog: pytest.LogCaptureFixture
) -> None:
    client = committed.client
    registered = (await register(client, email=committed.email)).json()
    rotated = (await refresh(client, registered["refresh_token"])).json()
    other_session = (await login(client, email=committed.email)).json()
    for response in (registered, rotated, other_session):
        await assert_signed_in(client, response["access_token"])

    assert (await logout(client, rotated["refresh_token"])).status_code == 204

    with caplog.at_level(logging.DEBUG):
        # Both access tokens of the session: the one before the rotation and the one after.
        await assert_refused(client, registered["access_token"])
        await assert_refused(client, rotated["access_token"])
    # The account's other session is another family: untouched.
    await assert_signed_in(client, other_session["access_token"])
    for response in (registered, rotated):
        assert response["access_token"] not in caplog.text
        assert response["refresh_token"] not in caplog.text


async def test_reuse_detection_refuses_the_family_s_access_tokens(
    committed: Committed,
) -> None:
    client = committed.client
    first = (await register(client, email=committed.email)).json()
    second = (await refresh(client, first["refresh_token"])).json()
    third = (await refresh(client, second["refresh_token"])).json()
    other_session = (await login(client, email=committed.email)).json()

    # The first token again, its successor already spent: a copy leaked (#116).
    assert (await refresh(client, first["refresh_token"])).status_code == 401

    for response in (first, second, third):
        await assert_refused(client, response["access_token"])
    await assert_signed_in(client, other_session["access_token"])


async def test_a_suspended_account_s_access_token_is_refused_at_the_next_request(
    committed: Committed,
) -> None:
    client = committed.client
    registered = (await register(client, email=committed.email)).json()
    await assert_signed_in(client, registered["access_token"])

    async with committed.sessions() as session:
        await session.execute(
            update(User).where(User.email == committed.email).values(status=UserStatus.SUSPENDED)
        )
        await session.commit()

    await assert_refused(client, registered["access_token"])
    assert (await refresh(client, registered["refresh_token"])).status_code == 401


async def set_role(
    session: AsyncSession, user_id: uuid.UUID, role: UserRole, *, expected: UserRole
) -> None:
    assert await UserService(session).set_role(user_id, role, expected=expected)
    await session.commit()


async def test_a_demoted_account_loses_the_role_at_the_next_request(
    committed: Committed,
) -> None:
    # The role is the account's, read on every request: the token's `role` claim is never used.
    client = committed.client
    registered = (await register(client, email=committed.email)).json()
    user_id = uuid.UUID(registered["user"]["id"])
    headers = {"Authorization": f"Bearer {registered['access_token']}"}
    staff_route = f"/v1/admin/jobs/{uuid.uuid4()}/messages"
    async with committed.sessions() as session:
        await set_role(session, user_id, UserRole.AGENT, expected=UserRole.CUSTOMER)

    # An agent: past the role check, and no such job.
    assert (await client.get(staff_route, headers=headers)).status_code == 404
    async with committed.sessions() as session:
        await set_role(session, user_id, UserRole.CUSTOMER, expected=UserRole.AGENT)

    demoted = await client.get(staff_route, headers=headers)
    assert demoted.status_code == 403
    assert demoted.json()["error"]["code"] == "forbidden"
    assert (await me(client, registered["access_token"])).json()["role"] == "customer"


async def test_a_token_issued_before_sid_works_until_it_expires(committed: Committed) -> None:
    # Expand only: the deploy logs nobody out. A token without `sid` names no session, so even
    # the end of every session leaves it working until its own expiry, at most
    # ACCESS_TOKEN_TTL_SECONDS after the deploy.
    client = committed.client
    registered = (await register(client, email=committed.email)).json()
    user_id = registered["user"]["id"]
    current = legacy_access_token(user_id, issued=datetime.now(UTC))
    expired = legacy_access_token(
        user_id, issued=datetime.now(UTC) - timedelta(seconds=ACCESS_TTL_SECONDS + 1)
    )
    assert (await logout(client, registered["refresh_token"])).status_code == 204

    await assert_signed_in(client, current)
    await assert_refused(client, expired)
    await assert_refused(client, registered["access_token"])


@pytest.mark.parametrize(
    "sid", ["another_account_s_live_session", "unknown_session", "not-a-uuid", 12345, None, ""]
)
async def test_a_sid_that_is_not_one_of_the_user_s_live_sessions_is_refused(
    db_client: httpx.AsyncClient, sid: object
) -> None:
    # Only the API's key signs tokens: these are what a bug minting a wrong `sid` would issue.
    # A claim check, no concurrency: the rolled-back session is enough.
    mine = (await register(db_client, email=f"sid-mine-{uuid.uuid4().hex}@example.com")).json()
    theirs = (await register(db_client, email=f"sid-theirs-{uuid.uuid4().hex}@example.com")).json()
    claims: dict[str, Any] = {"sub": mine["user"]["id"], "role": UserRole.CUSTOMER.value}
    # The same claims with the user's own live session are accepted: only `sid` differs.
    await assert_signed_in(db_client, signed({**claims, "sid": str(sid_of(mine["access_token"]))}))
    await assert_signed_in(db_client, theirs["access_token"])
    wrong = {
        "another_account_s_live_session": str(sid_of(theirs["access_token"])),
        "unknown_session": str(uuid.uuid4()),
    }.get(str(sid), sid)

    await assert_refused(db_client, signed({**claims, "sid": wrong}))


@contextmanager
def statements(engine: AsyncEngine) -> Iterator[list[str]]:
    """Every SQL statement the engine runs inside the block."""
    seen: list[str] = []

    def record(_conn: object, _cursor: object, statement: str, *_args: object) -> None:
        seen.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        yield seen
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)


async def test_an_authenticated_request_reads_its_session_and_writes_nothing(
    committed: Committed,
) -> None:
    client = committed.client
    registered = (await register(client, email=committed.email)).json()
    engine = committed.sessions.kw["bind"]
    assert isinstance(engine, AsyncEngine)

    with statements(engine) as seen:
        await assert_signed_in(client, registered["access_token"])

    assert [s for s in seen if RefreshToken.__tablename__ in s] != []
    assert all(s.lstrip().upper().startswith("SELECT") for s in seen), seen
