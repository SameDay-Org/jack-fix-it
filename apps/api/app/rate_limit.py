"""Fixed-window rate limiting on Redis, for routes that do expensive work before any auth.

A limit is checked in a FastAPI dependency, so a limited request never reaches the service.
Keys are `rl:<scope>:<identifier>:<window index>`. Identifiers that are PII (an email, a phone)
arrive as an HMAC-SHA-256 under RATE_LIMIT_KEY_SECRET (#137): emails and phone numbers are few
enough that a plain hash could be reversed by enumeration if Redis contents leaked.
"""

import asyncio
import hashlib
import hmac
import ipaddress
import logging
import math
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Annotated, Final, Protocol

from fastapi import Depends
from redis.asyncio import Redis
from redis.exceptions import RedisError
from starlette.requests import Request

from app.config import RATE_LIMIT_KEY_SECRET_REQUIRED_IN, Settings, get_app_settings
from app.errors import AppError

logger = logging.getLogger(__name__)

KEY_PREFIX: Final = "rl"
# Not a secret: the key development and test runs use when RATE_LIMIT_KEY_SECRET is unset.
# Settings refuses to start staging or production without the real one.
DEVELOPMENT_HMAC_KEY: Final = "jack-fix-it-development-rate-limit-key-not-secret"

# INCR, and EXPIRE only on the first hit of the window, as one atomic step.
_INCREMENT_SCRIPT: Final = """
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
"""


class RateLimitedError(AppError):
    """One body for every limit, so a 429 never tells which limit (or whose email) was hit."""

    status_code = 429
    code = "rate_limited"
    message = "Too many requests. Try again later."

    def __init__(self, retry_after_seconds: int) -> None:
        super().__init__()
        self.headers = {"Retry-After": str(retry_after_seconds)}


@dataclass(frozen=True)
class RateLimitResult:
    allowed: bool
    retry_after_seconds: int


class RateLimiter(Protocol):
    async def hit(
        self, scope: str, identifier: str, *, limit: int, window_seconds: int
    ) -> RateLimitResult:
        """Counts one request and says whether it is within `limit` for the current window."""
        ...


def window_position(now: float, window_seconds: int) -> tuple[int, int]:
    """The fixed window `now` falls in, and the seconds left in it (at least 1)."""
    index = int(now // window_seconds)
    return index, max(1, math.ceil((index + 1) * window_seconds - now))


class RedisRateLimiter:
    def __init__(
        self, redis: Redis, *, prefix: str = KEY_PREFIX, clock: Callable[[], float] = time.time
    ) -> None:
        self._increment = redis.register_script(_INCREMENT_SCRIPT)
        self._prefix = prefix
        self._clock = clock

    async def hit(
        self, scope: str, identifier: str, *, limit: int, window_seconds: int
    ) -> RateLimitResult:
        index, retry_after = window_position(self._clock(), window_seconds)
        key = f"{self._prefix}:{scope}:{identifier}:{index}"
        count = int(await self._increment(keys=[key], args=[window_seconds]))
        return RateLimitResult(allowed=count <= limit, retry_after_seconds=retry_after)


def hashed_identifier(value: str, secret: str) -> str:
    """For identifiers that are PII, such as an email: the key carries only the keyed digest."""
    return hmac.new(secret.encode(), value.encode(), hashlib.sha256).hexdigest()


@dataclass(frozen=True)
class IdentifierHasher:
    """hashed_identifier under the configured secret; build it with `from_settings`."""

    secret: str = field(repr=False)

    @classmethod
    def from_settings(cls, settings: Settings) -> "IdentifierHasher":
        if settings.rate_limit_key_secret is not None:
            return cls(settings.rate_limit_key_secret.get_secret_value())
        # Settings already refuses this; a hand-built Settings must not reach the fallback.
        if settings.app_env in RATE_LIMIT_KEY_SECRET_REQUIRED_IN:
            raise RuntimeError("RATE_LIMIT_KEY_SECRET is not set")
        return cls(DEVELOPMENT_HMAC_KEY)

    def __call__(self, value: str) -> str:
        return hashed_identifier(value, self.secret)


def get_identifier_hasher(
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> IdentifierHasher:
    return IdentifierHasher.from_settings(settings)


def get_rate_limiter(request: Request) -> RateLimiter:
    redis: Redis = request.app.state.redis
    return RedisRateLimiter(redis)


async def enforce_limit(
    limiter: RateLimiter,
    scope: str,
    identifier: str,
    *,
    limit: int,
    window_seconds: int,
    timeout_seconds: float,
) -> None:
    """Raises RateLimitedError above the limit.

    Fails open: when Redis is down, errors or does not answer within `timeout_seconds`, the
    request goes through and the outage is logged at ERROR (Sentry sees it). Availability wins
    over protection here; /health/ready already reports Redis as unavailable.
    """
    try:
        async with asyncio.timeout(timeout_seconds):
            result = await limiter.hit(
                scope, identifier, limit=limit, window_seconds=window_seconds
            )
    except (RedisError, OSError):  # OSError includes TimeoutError
        logger.error("rate_limit_unavailable", extra={"scope": scope})
        return
    if not result.allowed:
        raise RateLimitedError(result.retry_after_seconds)


def client_ip(request: Request) -> str:
    """The caller's address.

    Behind a proxy, uvicorn takes it from X-Forwarded-For, only for proxies in FORWARDED_ALLOW_IPS.
    """
    if request.client is None:
        return "unknown"
    host = request.client.host
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return host
    # An IPv4 client on the dual-stack socket arrives as ::ffff:a.b.c.d: one client, one bucket.
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return str(address.ipv4_mapped)
    return host


def limit_per_ip(scope: str) -> Callable[..., Awaitable[None]]:
    """A dependency allowing AUTH_RATE_LIMIT_REQUESTS per client IP per window on one route."""

    async def dependency(
        request: Request,
        limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
        settings: Annotated[Settings, Depends(get_app_settings)],
    ) -> None:
        await enforce_limit(
            limiter,
            scope,
            client_ip(request),
            limit=settings.auth_rate_limit_requests,
            window_seconds=settings.auth_rate_limit_window_seconds,
            timeout_seconds=settings.rate_limit_timeout_seconds,
        )

    return dependency
