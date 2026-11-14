"""One caller at a time asks Mapbox about an address (#384, Vault round 1).

The worker's task and the backfill script run the same step (addresses/geocode.py), and each
call it makes is billed. ARQ's job id keeps two worker jobs for one address apart and nothing
else: the script runs outside the queue, and two runs of it know nothing of each other. So
the step takes the address's claim before it asks, and only its holder asks.

- Where: the Redis of the queue (REDIS_URL). The worker has it as ctx["redis"], the script
  opens it. Never the positions' Redis, which is another one in staging and production.
- The claim is one key per address, set only while absent (SET NX PX), holding the token of
  the caller that took it.
- It ends by itself after `claim_seconds`: a holder that died keeps nobody out for longer.
- Its holder works for `work_seconds` at the most, counted from before it asked Redis for
  the claim: it is done, or has given up, EARLY_END_SECONDS before Redis lets the claim go.
  A slow step does not ask Mapbox, or send the point's COMMIT, past that time by the
  holder's own clock.
- What a clock cannot hold: a COMMIT sent in time lands when Postgres gets to it, and a
  holder stopped for longer than the margin with its clock stopped too (a suspended host)
  goes on believing its claim. Each is one more call at the most, never a wrong point: the
  write is conditional (AddressRepository.set_point).
- Released by its holder only: the key is deleted while it holds the releasing caller's
  token, the look and the delete in one script. A claim that ended by itself and is another
  caller's now is left alone.
- Redis failing or slow is GeocodeClaimUnavailableError, and without the claim Mapbox is not
  asked. Each call to Redis gets JOB_ENQUEUE_TIMEOUT_SECONDS, the queue's own deadline.
"""

import asyncio
import math
import uuid
from typing import Final, Protocol, Self

from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.config import Settings

_MILLISECONDS: Final = 1000
# What a claim's time has past the two deadlines of its turn (Redis taking it, Mapbox
# answering): the two short database steps around the call, the look after the claim and the
# write of the point.
DATABASE_SECONDS: Final = 2
# The holder's turn ends this long before Redis lets the claim go.
EARLY_END_SECONDS: Final = 1

# Deletes the claim (KEYS[1]) only while it holds ARGV[1], the token of the caller ending it.
_RELEASE_SCRIPT: Final = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""


class GeocodeClaimUnavailableError(Exception):
    """Redis failed or was slow: the claim was not taken, or not given back."""


def claim_key(address_id: uuid.UUID) -> str:
    return f"geocode-address-claim:{address_id}"


def claim_seconds(*, mapbox_timeout_seconds: float, redis_timeout_seconds: float) -> int:
    """How long Redis holds an address's claim. Redis counts from the moment it takes the
    claim, before its answer is back, so the time covers each step of the holder's turn as
    slow as its deadline lets it be: Mapbox's deadline and a margin."""
    deadlines = redis_timeout_seconds + mapbox_timeout_seconds
    return math.ceil(deadlines) + DATABASE_SECONDS + EARLY_END_SECONDS


class GeocodeClaims(Protocol):
    @property
    def work_seconds(self) -> float:
        """How long a holder may work, counted from before it asked for the claim."""
        ...

    async def claim(self, address_id: uuid.UUID, *, token: str) -> bool:
        """True for one caller per address at a time: the one that may ask Mapbox. False
        while another holds the claim. GeocodeClaimUnavailableError when Redis fails."""
        ...

    async def release(self, address_id: uuid.UUID, *, token: str) -> None:
        """Ends the claim taken with `token`, and only that one.
        GeocodeClaimUnavailableError when Redis fails: the claim then ends by itself."""
        ...


class RedisGeocodeClaims:
    def __init__(
        self, redis: Redis, *, mapbox_timeout_seconds: float, timeout_seconds: float
    ) -> None:
        self._redis = redis
        self._timeout = timeout_seconds
        self.claim_seconds: Final = claim_seconds(
            mapbox_timeout_seconds=mapbox_timeout_seconds, redis_timeout_seconds=timeout_seconds
        )
        self._release = redis.register_script(_RELEASE_SCRIPT)

    @classmethod
    def from_settings(cls, redis: Redis, settings: Settings) -> Self:
        return cls(
            redis,
            mapbox_timeout_seconds=settings.mapbox_timeout_seconds,
            timeout_seconds=settings.job_enqueue_timeout_seconds,
        )

    @property
    def work_seconds(self) -> float:
        return self.claim_seconds - EARLY_END_SECONDS

    async def claim(self, address_id: uuid.UUID, *, token: str) -> bool:
        try:
            async with asyncio.timeout(self._timeout):
                taken = await self._redis.set(
                    claim_key(address_id), token, nx=True, px=self.claim_seconds * _MILLISECONDS
                )
        except (RedisError, OSError) as error:  # OSError includes TimeoutError
            raise GeocodeClaimUnavailableError from error
        return bool(taken)

    async def release(self, address_id: uuid.UUID, *, token: str) -> None:
        try:
            async with asyncio.timeout(self._timeout):
                await self._release(keys=[claim_key(address_id)], args=[token])
        except (RedisError, OSError) as error:
            raise GeocodeClaimUnavailableError from error
