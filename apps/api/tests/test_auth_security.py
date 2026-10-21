"""Password hashing and token helpers (D4.2): pure functions, no database."""

import base64
import json
import re
import uuid
from datetime import UTC, datetime, timedelta

import jwt
import pytest

from app.modules.auth import security
from app.modules.users.models import UserRole
from tests.conftest import TEST_JWT_SECRET

TTL_SECONDS = 900


def make_token(*, now: datetime | None = None, secret: str = TEST_JWT_SECRET) -> str:
    return security.create_access_token(
        user_id=uuid.uuid4(),
        role=UserRole.CUSTOMER,
        secret=secret,
        ttl_seconds=TTL_SECONDS,
        now=now or datetime.now(UTC),
    )


def _b64(data: dict[str, object]) -> str:
    return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()


def test_hash_and_verify_roundtrip() -> None:
    password_hash = security.hash_password("correct horse battery")

    assert password_hash.startswith("$argon2id$")
    assert "correct horse battery" not in password_hash
    assert security.verify_password(password_hash, "correct horse battery")
    assert not security.password_needs_rehash(password_hash)


def test_verify_rejects_wrong_password() -> None:
    password_hash = security.hash_password("correct horse battery")

    assert not security.verify_password(password_hash, "wrong horse battery")
    assert not security.verify_password("not-an-argon2-hash", "correct horse battery")


def test_dummy_hash_matches_no_password() -> None:
    assert security.DUMMY_PASSWORD_HASH.startswith("$argon2id$")
    assert not security.verify_password(security.DUMMY_PASSWORD_HASH, "")


def test_access_token_roundtrip_claims() -> None:
    user_id = uuid.uuid4()
    token = security.create_access_token(
        user_id=user_id,
        role=UserRole.PRO,
        secret=TEST_JWT_SECRET,
        ttl_seconds=TTL_SECONDS,
        now=datetime.now(UTC),
    )

    claims = security.decode_access_token(token, secret=TEST_JWT_SECRET)
    raw = jwt.decode(token, TEST_JWT_SECRET, algorithms=["HS256"])

    assert claims.user_id == user_id
    assert claims.role is UserRole.PRO
    assert claims.expires_at - claims.issued_at == TTL_SECONDS
    assert raw["sub"] == str(user_id)
    assert raw["role"] == "pro"
    assert raw["typ"] == "access"
    assert raw["exp"] - raw["iat"] == TTL_SECONDS
    assert raw["jti"]
    assert jwt.get_unverified_header(token)["alg"] == "HS256"


def test_access_tokens_have_unique_jti() -> None:
    now = datetime.now(UTC)
    first = security.decode_access_token(make_token(now=now), secret=TEST_JWT_SECRET)
    second = security.decode_access_token(make_token(now=now), secret=TEST_JWT_SECRET)

    assert first.jti != second.jti


def test_decode_rejects_expired() -> None:
    token = make_token(now=datetime.now(UTC) - timedelta(seconds=TTL_SECONDS + 1))

    with pytest.raises(security.InvalidAccessTokenError):
        security.decode_access_token(token, secret=TEST_JWT_SECRET)


def test_decode_rejects_wrong_signature() -> None:
    token = make_token(secret="another-secret-of-at-least-32-characters")

    with pytest.raises(security.InvalidAccessTokenError):
        security.decode_access_token(token, secret=TEST_JWT_SECRET)


def test_decode_rejects_alg_none() -> None:
    now = int(datetime.now(UTC).timestamp())
    claims = {
        "sub": str(uuid.uuid4()),
        "role": "admin",
        "iat": now,
        "exp": now + TTL_SECONDS,
        "jti": "x",
        "typ": "access",
    }
    unsigned = f"{_b64({'alg': 'none', 'typ': 'JWT'})}.{_b64(claims)}."

    with pytest.raises(security.InvalidAccessTokenError):
        security.decode_access_token(unsigned, secret=TEST_JWT_SECRET)


def test_decode_rejects_refresh_typ() -> None:
    now = int(datetime.now(UTC).timestamp())
    claims = {
        "sub": str(uuid.uuid4()),
        "role": "customer",
        "iat": now,
        "exp": now + TTL_SECONDS,
        "jti": "x",
        "typ": "refresh",
    }
    token = jwt.encode(claims, TEST_JWT_SECRET, algorithm="HS256")

    with pytest.raises(security.InvalidAccessTokenError):
        security.decode_access_token(token, secret=TEST_JWT_SECRET)


@pytest.mark.parametrize("missing", ["exp", "sub", "typ"])
def test_decode_rejects_missing_required_claim(missing: str) -> None:
    now = int(datetime.now(UTC).timestamp())
    claims: dict[str, object] = {
        "sub": str(uuid.uuid4()),
        "role": "customer",
        "iat": now,
        "exp": now + TTL_SECONDS,
        "jti": "x",
        "typ": "access",
    }
    del claims[missing]
    token = jwt.encode(claims, TEST_JWT_SECRET, algorithm="HS256")

    with pytest.raises(security.InvalidAccessTokenError):
        security.decode_access_token(token, secret=TEST_JWT_SECRET)


@pytest.mark.parametrize("token", ["", "not-a-jwt", "a.b.c"])
def test_decode_rejects_malformed(token: str) -> None:
    with pytest.raises(security.InvalidAccessTokenError):
        security.decode_access_token(token, secret=TEST_JWT_SECRET)


def test_refresh_token_is_hashed() -> None:
    raw = security.new_refresh_token()
    stored = security.hash_refresh_token(raw)

    assert stored != raw
    assert re.fullmatch(r"[0-9a-f]{64}", stored)
    assert stored == security.hash_refresh_token(raw)
    assert security.new_refresh_token() != raw
