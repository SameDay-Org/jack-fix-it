"""One caller at a time asks Mapbox about an address, and one call per address per window
(#384, Vault rounds 1 and 2).

The worker's task and the backfill script run the same step (addresses/geocode.py), and each
call it makes is billed. ARQ's job id keeps two worker jobs for one address apart and nothing
else: the script runs outside the queue, and two runs of it know nothing of each other. Two
keys in Redis keep them apart, each with its own job:

- The claim coordinates: one caller at a time holds the address, and only its holder looks
  at the row again and goes on. It is a lease, and a lease can end under a holder that is
  still at work: a holder paused past its time, a COMMIT sent in time that lands later, a
  key lost in Redis.
- The attempt marker records that a billed call started. Its holder writes it once the claim
  is held and the row, read again, still has no point, and only then asks Mapbox. It lasts
  the attempt window (GEOCODE_ATTEMPT_WINDOW_SECONDS, 30 minutes by default), far longer
  than a claim and than any COMMIT in flight, and nobody deletes it: not the release of the
  claim, not an answer that keeps nothing, not a failure. It ends by itself. A caller that
  finds it asks nothing (BUSY), so a lease that ended early lets nobody pay a second time:
  one billed call per address per window. A later backfill run within the window skips
  that address too, which is intended; the run after the window asks about it again.

The keys:

- Where: the Redis of the queue (REDIS_URL). The worker has it as ctx["redis"], the script
  opens it. Never the positions' Redis, which is another one in staging and production.
- What: the address's id in the key, a random token (the holder's) as the value. Never a part
  of the address.
- The claim: one key per address, set only while absent (SET NX PX), holding the token of
  the caller that took it. It ends by itself after `claim_seconds`: a holder that died keeps
  nobody out for longer. Its holder works for `work_seconds` at the most, counted from
  before it asked Redis for the claim: it is done, or has given up, EARLY_END_SECONDS
  before Redis lets the claim go. Released by its holder only: the key is deleted while it
  holds the releasing caller's token, the look and the delete in one script. A claim that
  ended by itself and is another caller's now is left alone.
- The marker: one key per address, set only while absent (SET NX PX) for the attempt window.
  Set fails: an attempt started within the window, and this caller asks nothing.
- Redis failing or slow, at the claim, the marker or the release, is
  GeocodeClaimUnavailableError, which carries nothing of Redis's own error (raised from
  None, so no message or cause of it reaches a log or Sentry). Without the claim and the
  marker Mapbox is not asked. Each call to Redis gets JOB_ENQUEUE_TIMEOUT_SECONDS, the
  queue's own deadline.
- The window is longer than the claim, or nothing is built (ValueError): a mark that ended
  inside its holder's turn would record nothing.
- The limit: the marks live in Redis. If the queue's Redis loses them within the window (a
  flush, a failover without persistence, an eviction under a maxmemory-policy other than
  noeviction), each address asked about within the window and still without a point can be
  asked about once more: one extra billed call per address, bounded by the request limiter
  for the worker and by the typed count for a backfill run. Never a wrong point: the write
  is conditional (AddressRepository.set_point).
"""

import asyncio
import math
import uuid
from typing import Final, Protocol, Self

from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.config import Settings

_MILLISECONDS: Final = 1000
# What a claim's time has past the deadlines of its turn (Redis taking the claim, Redis
# taking the marker, Mapbox answering): the two short database steps around the call, the
# look after the claim and the write of the point.
DATABASE_SECONDS: Final = 2
# The holder's turn ends this long before Redis lets the claim go.
EARLY_END_SECONDS: Final = 1
# The Redis calls of a turn: the claim and the marker. (The release comes after the turn.)
_REDIS_CALLS_PER_TURN: Final = 2

# Deletes the claim (KEYS[1]) only while it holds ARGV[1], the token of the caller ending it.
_RELEASE_SCRIPT: Final = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""


class GeocodeClaimUnavailableError(Exception):
    """Redis failed or was slow: the claim or the marker was not taken, or the claim was not
    given back. Raised from None: it carries no text of Redis's error."""


def claim_key(address_id: uuid.UUID) -> str:
    return f"geocode-address-claim:{address_id}"


def attempt_key(address_id: uuid.UUID) -> str:
    return f"geocode-address-attempt:{address_id}"


def claim_seconds(*, mapbox_timeout_seconds: float, redis_timeout_seconds: float) -> int:
    """How long Redis holds an address's claim. Redis counts from the moment it takes the
    claim, before its answer is back, so the time covers each step of the holder's turn as
    slow as its deadline lets it be: the marker's Redis call, Mapbox's deadline and a
    margin."""
    deadlines = _REDIS_CALLS_PER_TURN * redis_timeout_seconds + mapbox_timeout_seconds
    return math.ceil(deadlines) + DATABASE_SECONDS + EARLY_END_SECONDS


class GeocodeClaims(Protocol):
    @property
    def work_seconds(self) -> float:
        """How long a holder may work, counted from before it asked for the claim."""
        ...

    async def claim(self, address_id: uuid.UUID, *, token: str) -> bool:
        """True for one caller per address at a time: the one that may go on. False while
        another holds the claim. GeocodeClaimUnavailableError when Redis fails."""
        ...

    async def mark_attempt(self, address_id: uuid.UUID, *, token: str) -> bool:
        """Records that a billed call about the address starts now, unless one started
        within the attempt window: True, the caller may ask Mapbox; False, it must not.
        Nothing removes the mark; it ends with its window. GeocodeClaimUnavailableError
        when Redis fails: the caller must not ask either."""
        ...

    async def release(self, address_id: uuid.UUID, *, token: str) -> None:
        """Ends the claim taken with `token`, and only that one. The attempt's mark stays.
        GeocodeClaimUnavailableError when Redis fails: the claim then ends by itself."""
        ...


class RedisGeocodeClaims:
    def __init__(
        self,
        redis: Redis,
        *,
        mapbox_timeout_seconds: float,
        timeout_seconds: float,
        attempt_window_seconds: float,
    ) -> None:
        self._redis = redis
        self._timeout = timeout_seconds
        self.claim_seconds: Final = claim_seconds(
            mapbox_timeout_seconds=mapbox_timeout_seconds, redis_timeout_seconds=timeout_seconds
        )
        if attempt_window_seconds <= self.claim_seconds:
            raise ValueError(
                "GEOCODE_ATTEMPT_WINDOW_SECONDS must be longer than an address's claim "
                f"({self.claim_seconds} s with MAPBOX_TIMEOUT_SECONDS and "
                "JOB_ENQUEUE_TIMEOUT_SECONDS as set): a mark that ends inside its holder's turn "
                "records nothing"
            )
        self.attempt_window_seconds: Final = attempt_window_seconds
        self._release = redis.register_script(_RELEASE_SCRIPT)

    @classmethod
    def from_settings(cls, redis: Redis, settings: Settings) -> Self:
        return cls(
            redis,
            mapbox_timeout_seconds=settings.mapbox_timeout_seconds,
            timeout_seconds=settings.job_enqueue_timeout_seconds,
            attempt_window_seconds=settings.geocode_attempt_window_seconds,
        )

    @property
    def work_seconds(self) -> float:
        return self.claim_seconds - EARLY_END_SECONDS

    async def claim(self, address_id: uuid.UUID, *, token: str) -> bool:
        return await self._set_once(
            claim_key(address_id), token, milliseconds=self.claim_seconds * _MILLISECONDS
        )

    async def mark_attempt(self, address_id: uuid.UUID, *, token: str) -> bool:
        return await self._set_once(
            attempt_key(address_id),
            token,
            milliseconds=math.ceil(self.attempt_window_seconds * _MILLISECONDS),
        )

    async def release(self, address_id: uuid.UUID, *, token: str) -> None:
        try:
            async with asyncio.timeout(self._timeout):
                await self._release(keys=[claim_key(address_id)], args=[token])
        except (RedisError, OSError):
            raise GeocodeClaimUnavailableError from None

    async def _set_once(self, key: str, token: str, *, milliseconds: int) -> bool:
        """SET NX PX: True when this call set the key."""
        try:
            async with asyncio.timeout(self._timeout):
                taken = await self._redis.set(key, token, nx=True, px=milliseconds)
        except (RedisError, OSError):  # OSError includes TimeoutError
            raise GeocodeClaimUnavailableError from None
        return bool(taken)
