"""Per-row claims and sweep marks for the safe copies (#491 round 1), kept in the queue's own
Redis: no schema change.

- A claim: one run copies one row at a time. The copier claims a row (SET NX, a random token,
  an expiry above the longest one row's copy may take) before it downloads, transforms or
  uploads anything, and releases it once the row's outcome is recorded, or on any other way
  out (a fault, an outage, the try's deadline, a cancel): only its own token is released.
  A worker that dies leaves a claim that expires on its own. Another run (a retry, the sweep's
  task, an earlier batch's task) finds the row held and leaves it to the holder.
- When each unit was last queued by the sweep (#491 round 2): a sorted set per kind (the unit's
  key, the time in epoch seconds). The sweep skips units queued within the wait window and takes
  the rest never queued first, then least recently queued: rows that keep being postponed (an
  outage that lasts) take their turn, and the rows behind them are reached within as many runs
  as there are units in the scan, however the window expires. The set expires with its kind's
  sweeps, and entries older than its keep are trimmed on every write: it never grows unbounded.

Keys carry ids only.
"""

import uuid
from collections.abc import Sequence
from typing import Final, Protocol

from redis.asyncio import Redis

PREFIX: Final = "media-copy"
# Deletes the claim only when it still holds the caller's token.
_RELEASE: Final = (
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) "
    "else return 0 end"
)


def row_key(kind: str, row_id: uuid.UUID) -> str:
    """One media row of one kind (its rows' parent field: request_id, job_id, dispute_id)."""
    return f"{kind}:{row_id}"


class MediaCopyStore(Protocol):
    async def claim(self, key: str) -> str | None:
        """A token when the row is claimed now; None when another run holds it."""
        ...

    async def release(self, key: str, token: str) -> None:
        """Ends the claim if it still holds `token`."""
        ...

    async def held(self, keys: Sequence[str]) -> set[str]:
        """The keys among these that a run holds now."""
        ...

    async def last_queued(self, kind: str, keys: Sequence[str]) -> dict[str, float]:
        """When the sweep last queued each unit among these, in epoch seconds; units it never
        queued (or forgot: past the keep) are left out."""
        ...

    async def record_queued(
        self, kind: str, keys: Sequence[str], at: float, keep_seconds: int
    ) -> None:
        """Records these units queued at `at`, and forgets entries older than `keep_seconds`."""
        ...


class RedisMediaCopyStore:
    def __init__(self, redis: Redis, *, claim_seconds: int, prefix: str = PREFIX) -> None:
        self._redis = redis
        self._claim_seconds = claim_seconds
        self._prefix = prefix
        self._release = redis.register_script(_RELEASE)

    def _claim_key(self, key: str) -> str:
        return f"{self._prefix}:claim:{key}"

    def _queued_key(self, kind: str) -> str:
        return f"{self._prefix}:queued:{kind}"

    async def claim(self, key: str) -> str | None:
        token = uuid.uuid4().hex
        claimed = await self._redis.set(
            self._claim_key(key), token, nx=True, ex=self._claim_seconds
        )
        return token if claimed else None

    async def release(self, key: str, token: str) -> None:
        await self._release(keys=[self._claim_key(key)], args=[token])

    async def held(self, keys: Sequence[str]) -> set[str]:
        return await self._present([self._claim_key(key) for key in keys], keys)

    async def last_queued(self, kind: str, keys: Sequence[str]) -> dict[str, float]:
        if not keys:
            return {}
        scores = await self._redis.zmscore(self._queued_key(kind), list(keys))
        return {key: score for key, score in zip(keys, scores, strict=True) if score is not None}

    async def record_queued(
        self, kind: str, keys: Sequence[str], at: float, keep_seconds: int
    ) -> None:
        if not keys:
            return
        name = self._queued_key(kind)
        async with self._redis.pipeline(transaction=False) as pipe:
            pipe.zadd(name, dict.fromkeys(keys, at))
            pipe.zremrangebyscore(name, "-inf", at - keep_seconds)
            pipe.expire(name, keep_seconds)
            await pipe.execute()

    async def _present(self, stored: Sequence[str], keys: Sequence[str]) -> set[str]:
        if not keys:
            return set()
        values = await self._redis.mget(stored)
        return {key for key, value in zip(keys, values, strict=True) if value is not None}
