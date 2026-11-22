"""Password hashing and token helpers. Pure functions: no database, no network, no logging.

Argon2 calls are CPU-bound (tens of ms); async callers run them in a worker thread.
"""

import base64
import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.modules.users.types import UserRole

JWT_ALGORITHM: Final = "HS256"
ACCESS_TOKEN_TYPE: Final = "access"  # noqa: S105 - the typ claim value, not a secret
# Not a secret: the rotation key development and test runs use when REFRESH_ROTATION_SECRET
# is unset. Settings refuses to start staging or production without the real one (#152).
DEVELOPMENT_ROTATION_KEY: Final = "jack-fix-it-development-refresh-rotation-key-not-secret"

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
    # The refresh family (session) it was issued with, the `sid` claim (#161). None for a token
    # without one: issued before #161, so it stops working when it expires.
    session_id: uuid.UUID | None


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
    *,
    user_id: uuid.UUID,
    role: UserRole,
    session_id: uuid.UUID | None,
    secret: str,
    ttl_seconds: int,
    now: datetime,
) -> str:
    """`session_id` is the refresh family the token belongs to (`sid`): revoking the family
    revokes the token (#161). The API always passes one; None mints the shape of a token issued
    before #161, without `sid`, which only tests and the local demo seed (scripts/demo) mint."""
    issued_at = int(now.timestamp())
    claims = {
        "sub": str(user_id),
        "role": role.value,
        "iat": issued_at,
        "exp": issued_at + ttl_seconds,
        "jti": uuid.uuid4().hex,
        "typ": ACCESS_TOKEN_TYPE,
    }
    if session_id is not None:
        claims["sid"] = str(session_id)
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
            session_id=_session_id(claims),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise InvalidAccessTokenError from exc


def _session_id(claims: dict[str, object]) -> uuid.UUID | None:
    """The `sid` claim: absent on a token issued before #161; present, it must be a UUID string
    (anything else is a malformed token, never one without a session)."""
    if "sid" not in claims:
        return None
    sid = claims["sid"]
    if not isinstance(sid, str):
        raise TypeError("sid is not a string")
    return uuid.UUID(sid)


def new_refresh_token() -> str:
    """An opaque token for the client. Only its hash is stored."""
    return secrets.token_urlsafe(32)


def successor_refresh_token(token: str, rotation_key: str) -> str:
    """The token a rotation of `token` issues (#152): base64url of HMAC-SHA256 under the rotation
    key, 43 characters like new_refresh_token.

    Deterministic, so a retried refresh can be answered with the same successor while only its
    hash is stored; unguessable without the key. Only a rotation uses it: the first token of a
    family (login, registration) is random.
    """
    message = b"rotate:" + token.encode("utf-8", "surrogatepass")
    digest = hmac.new(rotation_key.encode(), message, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def hash_refresh_token(token: str) -> str:
    """SHA-256 hex digest (64 characters): the token is random, so no salt or slow hash.

    Never raises: a client can send a lone surrogate in JSON, which plain UTF-8 cannot encode.
    Issued tokens are ASCII, so their digest is the same either way.
    """
    return hashlib.sha256(token.encode("utf-8", "surrogatepass")).hexdigest()
