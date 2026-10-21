"""Register, login and the current user over HTTP (D4.2 part 1, #25)."""

import hashlib
import json
import logging
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Literal

import httpx
import jwt
import pytest
from argon2 import PasswordHasher
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.modules.auth import security
from app.modules.auth.models import RefreshToken
from app.modules.users.errors import EmailAlreadyRegisteredError
from app.modules.users.models import User
from app.modules.users.service import UserService
from app.modules.users.types import UserRole, UserStatus
from app.observability import JsonFormatter
from tests.conftest import TEST_JWT_SECRET, make_app, make_settings

PASSWORD = "correct horse battery"
EMAIL = "ana@example.com"

INVALID_CREDENTIALS = {
    "error": {"code": "invalid_credentials", "message": "The email or password is incorrect."}
}
INVALID_TOKEN = {
    "error": {
        "code": "invalid_token",
        "message": "The access token is missing, invalid or expired.",
    }
}
VALIDATION_ERROR = {"error": {"code": "validation_error", "message": "The request is invalid."}}


async def register(
    client: httpx.AsyncClient,
    email: str = EMAIL,
    password: str = PASSWORD,
    role: str = "customer",
    **extra: object,
) -> httpx.Response:
    body = {"email": email, "password": password, "role": role, **extra}
    return await client.post("/v1/auth/register", json=body)


async def login(
    client: httpx.AsyncClient, email: str = EMAIL, password: str = PASSWORD
) -> httpx.Response:
    return await client.post("/v1/auth/login", json={"email": email, "password": password})


async def me(client: httpx.AsyncClient, token: str) -> httpx.Response:
    return await client.get("/v1/auth/me", headers={"Authorization": f"Bearer {token}"})


async def get_user(session: AsyncSession, email: str = EMAIL) -> User:
    return (await session.scalars(select(User).where(User.email == email))).one()


async def set_status(session: AsyncSession, email: str, status: UserStatus) -> None:
    user = await get_user(session, email)
    user.status = status
    await session.flush()


def assert_invalid_token(response: httpx.Response) -> None:
    assert response.status_code == 401
    assert response.json() == INVALID_TOKEN
    assert response.headers["WWW-Authenticate"] == "Bearer"


# Register


async def test_register_customer_returns_tokens_and_user(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    response = await register(db_client)

    assert response.status_code == 201
    body = response.json()
    user = await get_user(db_session)
    assert body["user"] == {
        "id": str(user.id),
        "email": EMAIL,
        "role": "customer",
        "locale": "en",
        "status": "active",
    }
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == 900
    claims = jwt.decode(body["access_token"], TEST_JWT_SECRET, algorithms=["HS256"])
    assert claims["sub"] == str(user.id)
    assert claims["role"] == "customer"
    assert claims["typ"] == "access"
    stored = (await db_session.scalars(select(RefreshToken))).one()
    assert stored.user_id == user.id
    assert stored.token_hash == hashlib.sha256(body["refresh_token"].encode()).hexdigest()
    assert stored.revoked_at is None
    assert stored.replaced_by_id is None
    assert stored.expires_at - stored.created_at == pytest.approx(
        timedelta(seconds=2_592_000), abs=timedelta(seconds=5)
    )


async def test_register_pro_with_spanish_locale(db_client: httpx.AsyncClient) -> None:
    response = await register(db_client, role="pro", locale="es")

    assert response.status_code == 201
    assert response.json()["user"]["role"] == "pro"
    assert response.json()["user"]["locale"] == "es"


async def test_register_lowercases_and_trims_email(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    response = await register(db_client, email="  Ana.Maria@Example.COM ")

    assert response.status_code == 201
    assert response.json()["user"]["email"] == "ana.maria@example.com"
    assert (await get_user(db_session, "ana.maria@example.com")).email == "ana.maria@example.com"


@pytest.mark.parametrize("role", ["agent", "admin"])
async def test_register_rejects_agent_and_admin_roles(
    db_client: httpx.AsyncClient, db_session: AsyncSession, role: str
) -> None:
    response = await register(db_client, role=role)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    assert (await db_session.scalars(select(User))).first() is None


@pytest.mark.parametrize(
    "body",
    [
        {"email": "not-an-email", "password": PASSWORD, "role": "customer"},
        {"email": EMAIL, "password": PASSWORD, "role": "customer", "locale": "pt"},
        {"email": EMAIL, "password": PASSWORD},
        {"email": EMAIL, "role": "customer"},
    ],
)
async def test_register_rejects_invalid_body(
    db_client: httpx.AsyncClient, body: dict[str, str]
) -> None:
    response = await db_client.post("/v1/auth/register", json=body)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR


async def test_register_rejects_short_and_too_long_password(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    too_short = await register(db_client, password="a" * 9)
    too_long = await register(db_client, password="a" * 129)

    assert too_short.status_code == 422
    assert too_short.json() == VALIDATION_ERROR
    assert too_long.status_code == 422
    assert too_long.json() == VALIDATION_ERROR
    assert (await db_session.scalars(select(User))).first() is None


@pytest.mark.parametrize("length", [10, 128])
async def test_register_accepts_password_length_bounds(
    db_client: httpx.AsyncClient, length: int
) -> None:
    # No composition rules: a single repeated character is accepted (NIST 800-63B).
    assert (await register(db_client, password="a" * length)).status_code == 201


async def test_password_minimum_comes_from_settings(db_session: AsyncSession) -> None:
    app = make_app(make_settings(password_min_length=16))

    async def test_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = test_session
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        assert (await register(client, password="a" * 15)).status_code == 422
        assert (await register(client, password="a" * 16)).status_code == 201


async def test_register_duplicate_email_conflict(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    assert (await register(db_client)).status_code == 201

    same = await register(db_client)
    other_case = await register(db_client, email="ANA@Example.com", role="pro")

    expected = {
        "error": {
            "code": "email_already_registered",
            "message": "An account with this email already exists.",
        }
    }
    assert same.status_code == 409
    assert same.json() == expected
    assert other_case.status_code == 409
    assert other_case.json() == expected
    assert len((await db_session.scalars(select(User))).all()) == 1


async def test_create_user_maps_unique_violation_to_conflict(db_session: AsyncSession) -> None:
    # create_user has no "email exists?" pre-check: every duplicate, including one from a
    # concurrent request, is caught as the uq_users_email violation of the INSERT itself.
    users = UserService(db_session)
    await users.create_user(email=EMAIL, password_hash="x", role=UserRole.CUSTOMER, locale="en")

    with pytest.raises(EmailAlreadyRegisteredError):
        await users.create_user(email=EMAIL, password_hash="y", role=UserRole.PRO, locale="en")

    # Only the savepoint was rolled back: the session and the first user are intact.
    credentials = await users.get_credentials_by_email(EMAIL)
    assert credentials is not None
    assert credentials.account.role is UserRole.CUSTOMER


async def test_register_stores_argon2id_hash_not_password(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    await register(db_client)

    user = await get_user(db_session)
    assert user.password_hash.startswith("$argon2id$")
    assert PASSWORD not in user.password_hash
    assert PasswordHasher().verify(user.password_hash, PASSWORD)


async def test_auth_without_jwt_secret_is_a_generic_500(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    app = make_app(make_settings(app_env="development", jwt_secret=None))

    async def test_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = test_session
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await register(client)

    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Internal server error."}
    }
    assert any(record.message == "unhandled_error" for record in caplog.records)
    assert (await db_session.scalars(select(User))).first() is None


# Login


async def test_login_success(db_client: httpx.AsyncClient, db_session: AsyncSession) -> None:
    await register(db_client)

    response = await login(db_client, email="  ANA@example.com")

    assert response.status_code == 200
    body = response.json()
    user = await get_user(db_session)
    assert body["user"]["id"] == str(user.id)
    assert body["user"]["email"] == EMAIL
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == 900
    claims = jwt.decode(body["access_token"], TEST_JWT_SECRET, algorithms=["HS256"])
    assert claims["sub"] == str(user.id)
    assert (await me(db_client, body["access_token"])).status_code == 200


async def test_login_unknown_email_and_wrong_password_same_response(
    db_client: httpx.AsyncClient,
) -> None:
    await register(db_client)

    unknown = await login(db_client, email="nobody@example.com")
    wrong = await login(db_client, password="wrong horse battery")

    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json() == wrong.json() == INVALID_CREDENTIALS
    assert "WWW-Authenticate" not in unknown.headers
    assert "WWW-Authenticate" not in wrong.headers


async def test_login_unknown_email_still_runs_verify(
    db_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    verified: list[str] = []

    class SpyHasher(PasswordHasher):
        def verify(self, hash: str | bytes, password: str | bytes) -> Literal[True]:
            verified.append(str(hash))
            return super().verify(hash, password)

    monkeypatch.setattr(security, "PASSWORD_HASHER", SpyHasher())

    response = await login(db_client, email="nobody@example.com")

    assert response.status_code == 401
    assert verified == [security.DUMMY_PASSWORD_HASH]


async def test_login_suspended_user_forbidden(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    await register(db_client)
    await set_status(db_session, EMAIL, UserStatus.SUSPENDED)

    response = await login(db_client)
    wrong_password = await login(db_client, password="wrong horse battery")

    assert response.status_code == 403
    assert response.json() == {
        "error": {"code": "account_suspended", "message": "This account is suspended."}
    }
    # A wrong password reveals nothing about the account's status.
    assert wrong_password.status_code == 401
    assert wrong_password.json() == INVALID_CREDENTIALS


async def test_login_creates_new_refresh_family(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    registered = (await register(db_client)).json()
    first = (await login(db_client)).json()
    second = (await login(db_client)).json()

    rows = (await db_session.scalars(select(RefreshToken))).all()
    raw_tokens = [body["refresh_token"] for body in (registered, first, second)]
    assert len(rows) == 3
    assert len({row.family_id for row in rows}) == 3
    assert len(set(raw_tokens)) == 3
    hashes = {row.token_hash for row in rows}
    assert hashes == {hashlib.sha256(raw.encode()).hexdigest() for raw in raw_tokens}
    assert hashes.isdisjoint(raw_tokens)


async def test_login_upgrades_an_outdated_hash(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    await register(db_client)
    user = await get_user(db_session)
    outdated = PasswordHasher(time_cost=1, memory_cost=8192).hash(PASSWORD)
    user.password_hash = outdated
    await db_session.flush()

    assert (await login(db_client)).status_code == 200

    await db_session.refresh(user)
    assert user.password_hash != outdated
    assert not security.password_needs_rehash(user.password_hash)
    assert security.verify_password(user.password_hash, PASSWORD)


async def test_login_failure_log_has_no_email(
    db_client: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    await register(db_client)
    caplog.clear()

    with caplog.at_level(logging.INFO):
        await login(db_client, email="nobody@example.com")
        await login(db_client, password="wrong horse battery")

    failures = [record for record in caplog.records if record.message == "auth_login_failed"]
    assert [getattr(record, "reason", None) for record in failures] == [
        "unknown_email",
        "bad_password",
    ]
    formatter = JsonFormatter()
    output = "\n".join(formatter.format(record) for record in caplog.records)
    for secret in ("nobody@example.com", EMAIL, "wrong horse battery", PASSWORD, "argon2"):
        assert secret not in output


# Current user


async def test_me_requires_bearer(db_client: httpx.AsyncClient, db_session: AsyncSession) -> None:
    await register(db_client)
    user = await get_user(db_session)
    expired = security.create_access_token(
        user_id=user.id,
        role=user.role,
        secret=TEST_JWT_SECRET,
        ttl_seconds=900,
        now=datetime.now(UTC) - timedelta(seconds=901),
    )

    assert_invalid_token(await db_client.get("/v1/auth/me"))
    for header in ("Basic dXNlcjpwYXNz", "Bearer", "Bearer not-a-jwt", expired):
        response = await db_client.get("/v1/auth/me", headers={"Authorization": header})
        assert_invalid_token(response)
    assert_invalid_token(await me(db_client, expired))


async def test_me_rejects_token_signed_with_another_secret(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    await register(db_client)
    user = await get_user(db_session)
    forged = security.create_access_token(
        user_id=user.id,
        role=UserRole.ADMIN,
        secret="another-secret-of-at-least-32-characters",
        ttl_seconds=900,
        now=datetime.now(UTC),
    )

    assert_invalid_token(await me(db_client, forged))


async def test_me_rejects_refresh_token_as_bearer(db_client: httpx.AsyncClient) -> None:
    body = (await register(db_client)).json()

    assert_invalid_token(await me(db_client, body["refresh_token"]))


async def test_me_returns_own_user(db_client: httpx.AsyncClient) -> None:
    ana = (await register(db_client)).json()
    bruno = (await register(db_client, email="bruno@example.com", role="pro")).json()

    ana_me = await me(db_client, ana["access_token"])
    bruno_me = await me(db_client, bruno["access_token"])

    assert ana_me.status_code == 200
    assert ana_me.json() == ana["user"]
    assert bruno_me.status_code == 200
    assert bruno_me.json() == bruno["user"]


async def test_me_rejects_token_of_suspended_user(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    body = (await register(db_client)).json()
    await set_status(db_session, EMAIL, UserStatus.SUSPENDED)

    assert_invalid_token(await me(db_client, body["access_token"]))


async def test_me_rejects_token_of_unknown_user(db_client: httpx.AsyncClient) -> None:
    token = security.create_access_token(
        user_id=uuid.uuid4(),
        role=UserRole.CUSTOMER,
        secret=TEST_JWT_SECRET,
        ttl_seconds=900,
        now=datetime.now(UTC),
    )

    assert_invalid_token(await me(db_client, token))


async def test_responses_never_contain_password_hash(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    responses = [await register(db_client)]
    responses.append(await login(db_client))
    responses.append(await me(db_client, responses[0].json()["access_token"]))
    responses.append(await register(db_client))
    responses.append(await login(db_client, password="wrong horse battery"))
    user = await get_user(db_session)

    for response in responses:
        assert user.password_hash not in response.text
        assert "argon2" not in response.text
        assert "password_hash" not in json.dumps(response.json())
        assert PASSWORD not in response.text
