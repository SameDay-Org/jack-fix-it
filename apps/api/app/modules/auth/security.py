"""Password hashing and token helpers. Pure functions: no database, no network, no logging.

Argon2 calls are CPU-bound (tens of ms); async callers run them in a worker thread.
"""

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.modules.users.models import UserRole

JWT_ALGORITHM: Final = "HS256"
ACCESS_TOKEN_TYPE: Final = "access"  # noqa: S105 - the typ claim value, not a secret

# argon2-cffi defaults: Argon2id with the library's recommended cost.
PASSWORD_HASHER = PasswordHasher()
# Verified when the email is unknown, so a login costs one Argon2 verify either way.
# Hashed from a random value at import: no password matches it.
DUMMY_PASSWORD_HASH: Final = PASSWORD_HASHER.hash(secrets.token_urlsafe(32))


class InvalidAccessTokenError(Exception):
    """The token is malformed, forged, expired or not an access token."""


@dataclass(frozen=True)
class AccessTokenClaims:
    user_id: uuid.UUID
    role: UserRole
    jti: str
    issued_at: int
    expires_at: int


def hash_password(password: str) -> str:
    return PASSWORD_HASHER.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    """True when the password matches. A mismatch or an unreadable hash is False."""
    try:
        return PASSWORD_HASHER.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def password_needs_rehash(password_hash: str) -> bool:
    """True when the hash was made with other parameters than the current defaults."""
    return PASSWORD_HASHER.check_needs_rehash(password_hash)


def create_access_token(
    *, user_id: uuid.UUID, role: UserRole, secret: str, ttl_seconds: int, now: datetime
) -> str:
    issued_at = int(now.timestamp())
    claims = {
        "sub": str(user_id),
        "role": role.value,
        "iat": issued_at,
        "exp": issued_at + ttl_seconds,
        "jti": uuid.uuid4().hex,
        "typ": ACCESS_TOKEN_TYPE,
    }
    return jwt.encode(claims, secret, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str, *, secret: str) -> AccessTokenClaims:
    """Verifies the HS256 signature, expiry and claims. Raises InvalidAccessTokenError."""
    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=[JWT_ALGORITHM],
            options={"require": ["exp", "iat", "sub", "jti", "typ"]},
        )
    except jwt.InvalidTokenError as exc:
        raise InvalidAccessTokenError from exc
    if claims["typ"] != ACCESS_TOKEN_TYPE:
        raise InvalidAccessTokenError
    try:
        return AccessTokenClaims(
            user_id=uuid.UUID(claims["sub"]),
            role=UserRole(claims["role"]),
            jti=str(claims["jti"]),
            issued_at=int(claims["iat"]),
            expires_at=int(claims["exp"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise InvalidAccessTokenError from exc


def new_refresh_token() -> str:
    """An opaque token for the client. Only its hash is stored."""
    return secrets.token_urlsafe(32)


def hash_refresh_token(token: str) -> str:
    """SHA-256 hex digest (64 characters): the token is random, so no salt or slow hash."""
    return hashlib.sha256(token.encode()).hexdigest()
