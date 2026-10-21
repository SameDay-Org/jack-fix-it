"""Password reset by a 6-digit code sent by email (D4.3, #27).

- forgot: always 202. The account lookup, the code and the email happen after the response
  (send_code, a background task), so neither the answer nor its timing tells whether an
  account exists. Only an active account gets a code.
- reset: the code, the email and the new password. Any problem with the code (none, expired,
  wrong, used, too many tries, unknown or suspended account) is the same 400 invalid_code. A
  success spends the code, stores the new password hash and revokes every session.

Codes live in Redis, never in a table: one hash per email under `<prefix>:<hashed email>`
with the code's digest and a try counter, expiring after PASSWORD_RESET_CODE_TTL_SECONDS. A
new request replaces the previous code. Email and code enter Redis only as HMACs under
RATE_LIMIT_KEY_SECRET (IdentifierHasher): a plain SHA-256 of a 6-digit code is reversed in a
million tries.

Logs carry the user id at most: never the email, the code or a digest.
"""

import asyncio
import hmac
import logging
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Final

from fastapi import Depends
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from app.config import Settings, get_app_settings
from app.integrations.email import EmailSender, EmailUnavailableError
from app.modules.auth import security
from app.modules.auth.email_copy import password_reset_code_email
from app.modules.auth.errors import InvalidCodeError, PasswordTooShortError
from app.modules.auth.repository import RefreshTokenRepository
from app.modules.users.service import UserService
from app.modules.users.types import UserStatus
from app.rate_limit import IdentifierHasher, RateLimiter

logger = logging.getLogger(__name__)

KEY_PREFIX: Final = "pwreset"
DAILY_SCOPE: Final = "password_reset_daily"
CODE_DIGITS: Final = 6

# One try, atomically: counts it and, within the limit, returns the stored digest and the count.
# Every try counts, the right one included, so concurrent guesses cannot exceed the limit.
_CLAIM_SCRIPT: Final = """
local digest = redis.call('HGET', KEYS[1], 'code')
if not digest then
  return false
end
local tries = redis.call('HINCRBY', KEYS[1], 'tries', 1)
if tries > tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
  return false
end
return {digest, tries}
"""

# Deletes the code only if it is still the one that was checked: of two requests spending the
# same code, one wins; a code replaced in between is left alone.
_DELETE_IF_SCRIPT: Final = """
if redis.call('HGET', KEYS[1], 'code') == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""


@dataclass(frozen=True)
class StoredCode:
    digest: str
    tries: int


class ResetCodeStore:
    """Every call gives up after `timeout_seconds` (TimeoutError): a hung Redis must not hang
    a request, or a background task, with no end."""

    def __init__(self, redis: Redis, *, timeout_seconds: float, prefix: str = KEY_PREFIX) -> None:
        self._redis = redis
        self._timeout = timeout_seconds
        self._prefix = prefix
        self._claim = redis.register_script(_CLAIM_SCRIPT)
        self._delete_if = redis.register_script(_DELETE_IF_SCRIPT)

    def key(self, email_id: str) -> str:
        return f"{self._prefix}:{email_id}"

    async def put(self, email_id: str, digest: str, ttl_seconds: int) -> None:
        """Stores a new code for the email, replacing any previous one and its tries (HSET
        overwrites both fields; EXPIRE restarts the lifetime)."""
        key = self.key(email_id)
        async with asyncio.timeout(self._timeout), self._redis.pipeline(transaction=True) as pipe:
            pipe.hset(key, mapping={"code": digest, "tries": 0})
            pipe.expire(key, ttl_seconds)
            await pipe.execute()

    async def claim_try(self, email_id: str, max_tries: int) -> StoredCode | None:
        """Counts one try. None when there is no code, or it just ran out of tries."""
        async with asyncio.timeout(self._timeout):
            result = await self._claim(keys=[self.key(email_id)], args=[max_tries])
        if not result:
            return None
        digest, tries = result
        return StoredCode(digest=_text(digest), tries=int(tries))

    async def delete_if(self, email_id: str, digest: str) -> bool:
        """True when this call deleted the code `digest`."""
        async with asyncio.timeout(self._timeout):
            return bool(await self._delete_if(keys=[self.key(email_id)], args=[digest]))


def _text(value: bytes | str) -> str:
    return value.decode() if isinstance(value, bytes) else value


@dataclass(frozen=True)
class PasswordResetConfig:
    code_ttl_seconds: int
    max_attempts: int
    password_min_length: int
    daily_limit: int
    daily_window_seconds: int
    redis_timeout_seconds: float

    @classmethod
    def from_settings(cls, settings: Settings) -> "PasswordResetConfig":
        return cls(
            code_ttl_seconds=settings.password_reset_code_ttl_seconds,
            max_attempts=settings.password_reset_max_attempts,
            password_min_length=settings.password_min_length,
            daily_limit=settings.password_reset_daily_limit,
            daily_window_seconds=settings.password_reset_daily_window_seconds,
            redis_timeout_seconds=settings.rate_limit_timeout_seconds,
        )


def new_code() -> str:
    return f"{secrets.randbelow(10**CODE_DIGITS):0{CODE_DIGITS}d}"


class PasswordResetService:
    def __init__(
        self,
        session: AsyncSession,
        users: UserService,
        store: ResetCodeStore,
        sender: EmailSender,
        hasher: IdentifierHasher,
        limiter: RateLimiter,
        config: PasswordResetConfig,
    ) -> None:
        self._session = session
        self._limiter = limiter
        self._users = users
        self._refresh_tokens = RefreshTokenRepository(session)
        self._store = store
        self._sender = sender
        self._hasher = hasher
        self._config = config

    async def send_code(self, email: str) -> None:
        """Emails a new code to an active account, at most PASSWORD_RESET_DAILY_LIMIT codes per
        account per window. Runs after the response: a capped request, or a Redis or email
        failure, is logged and the user simply gets no new code (an earlier one still works)."""
        credentials = await self._users.get_credentials_by_email(email)
        if credentials is None or credentials.account.status is not UserStatus.ACTIVE:
            reason = "unknown_email" if credentials is None else "inactive"
            logger.info("password_reset_not_sent", extra={"reason": reason})
            return
        user = credentials.account
        # Ends the read transaction, so no pooled connection waits on Redis or Resend.
        await self._session.rollback()
        extra = {"user_id": str(user.id)}
        email_id = self._hasher(email)
        try:
            # Fails closed: when the count cannot be taken, no code is issued.
            async with asyncio.timeout(self._config.redis_timeout_seconds):
                daily = await self._limiter.hit(
                    DAILY_SCOPE,
                    email_id,
                    limit=self._config.daily_limit,
                    window_seconds=self._config.daily_window_seconds,
                )
            if not daily.allowed:
                # The hashed id only (Cesar, 2026-10-21): repeated hits show one target.
                logger.warning("password_reset_daily_cap_reached", extra={"email_id": email_id})
                return
            code = new_code()
            await self._store.put(email_id, self._code_digest(code), self._config.code_ttl_seconds)
        except (RedisError, OSError):  # OSError includes TimeoutError
            logger.error("password_reset_store_unavailable", extra=extra)
            return
        content = password_reset_code_email(user.locale, code, self._config.code_ttl_seconds)
        try:
            await self._sender.send(user.email, content.subject, content.text, content.html)
        except EmailUnavailableError:
            logger.error("password_reset_email_unavailable", extra=extra)
            return
        logger.info("password_reset_code_sent", extra=extra)

    async def reset(self, email: str, code: str, new_password: str) -> None:
        """Spends the code, sets the new password and revokes every session, then commits."""
        if len(new_password) < self._config.password_min_length:
            raise PasswordTooShortError
        email_id = self._hasher(email)
        stored = await self._store.claim_try(email_id, self._config.max_attempts)
        if stored is None:
            raise InvalidCodeError
        if not hmac.compare_digest(stored.digest, self._code_digest(code)):
            if stored.tries >= self._config.max_attempts:
                await self._store.delete_if(email_id, stored.digest)
            raise InvalidCodeError
        if not await self._store.delete_if(email_id, stored.digest):
            raise InvalidCodeError  # spent or replaced by a concurrent request
        # Locked: a login of this user in flight finishes first, so the revocation below sees
        # its session; a login that starts now waits and then reads the new hash.
        credentials = await self._users.get_credentials_by_email(email, lock=True)
        if credentials is None or credentials.account.status is not UserStatus.ACTIVE:
            raise InvalidCodeError
        user = credentials.account
        password_hash = await asyncio.to_thread(security.hash_password, new_password)
        await self._users.update_password_hash(user.id, password_hash)
        await self._refresh_tokens.revoke_all_for_user(user.id, datetime.now(UTC))
        await self._session.commit()
        logger.info("password_reset", extra={"user_id": str(user.id)})

    def _code_digest(self, code: str) -> str:
        # Its own prefix, so a code's digest never equals an identifier's.
        return self._hasher(f"password_reset_code:{code}")


def get_reset_code_store(
    request: Request, settings: Annotated[Settings, Depends(get_app_settings)]
) -> ResetCodeStore:
    redis: Redis = request.app.state.redis
    return ResetCodeStore(redis, timeout_seconds=settings.rate_limit_timeout_seconds)
