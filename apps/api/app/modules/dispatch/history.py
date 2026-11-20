"""The re-dispatch sweep's own state (#478 round 1), in the queue's Redis: ids and times only.

- The cursor: the (created_at, id) of the last stalled request the sweep went past. Each run
  reads the next REDISPATCH_BATCH_SIZE stalled requests after it, oldest first, and wraps to the
  oldest when it reaches the end. So every stalled request is reached within as many runs as
  there are batches of them, whatever sits ahead of it: requests no pro can take never hold the
  front.
- When each request was last queued by the sweep: a sorted set (the request id, the time in
  epoch seconds). A request queued within REDISPATCH_RETRY_MINUTES is passed over (the cursor
  still moves past it), so one no pro can take is tried again at most once per retry window, not
  every run, and never less than once per round of the cursor.

Both keys are written together once a run has read its batch, before it queues anything (a run
whose write fails queues nothing: dispatch.tasks.sweep_stalled), and expire after `keep`: entries
older than it are trimmed on every write (the set never grows unbounded), and a forgotten entry
only makes a request due again. A cursor that expired only starts the next round from the
oldest. The caller passes the keep (dispatch.stalled.history_keep). The kick never reads it.
"""

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Protocol

from redis.asyncio import Redis

Cursor = tuple[datetime, uuid.UUID]


class RedispatchHistory(Protocol):
    async def cursor(self) -> Cursor | None:
        """Where the last run stopped; None before the first run (or once it expired)."""
        ...

    async def queued_at(self, request_ids: Sequence[str]) -> dict[str, float]:
        """When the sweep last queued each of these requests; those it never queued (or
        forgot) are left out."""
        ...

    async def record(
        self, queued: Sequence[str], at: float, cursor: Cursor | None, keep_seconds: int
    ) -> None:
        """Records the requests queued at `at` and where the run stopped; forgets entries older
        than `keep_seconds`."""
        ...


def _encode(cursor: Cursor) -> str:
    created_at, request_id = cursor
    return f"{created_at.astimezone(UTC).isoformat()}|{request_id}"


def _decode(value: str) -> Cursor | None:
    created_at, _, request_id = value.partition("|")
    try:
        return datetime.fromisoformat(created_at), uuid.UUID(request_id)
    except ValueError:
        return None  # not ours: start over from the oldest


class RedisRedispatchHistory:
    def __init__(self, redis: Redis, prefix: str = "redispatch") -> None:
        self._redis = redis
        self._cursor_key = f"{prefix}:cursor"
        self._queued_key = f"{prefix}:queued"

    async def cursor(self) -> Cursor | None:
        value = await self._redis.get(self._cursor_key)
        if value is None:
            return None
        return _decode(value.decode() if isinstance(value, bytes) else str(value))

    async def queued_at(self, request_ids: Sequence[str]) -> dict[str, float]:
        if not request_ids:
            return {}
        scores = await self._redis.zmscore(self._queued_key, list(request_ids))
        return {
            key: score for key, score in zip(request_ids, scores, strict=True) if score is not None
        }

    async def record(
        self, queued: Sequence[str], at: float, cursor: Cursor | None, keep_seconds: int
    ) -> None:
        async with self._redis.pipeline(transaction=False) as pipe:
            if queued:
                pipe.zadd(self._queued_key, dict.fromkeys(queued, at))
            pipe.zremrangebyscore(self._queued_key, "-inf", at - keep_seconds)
            pipe.expire(self._queued_key, keep_seconds)
            if cursor is None:
                pipe.delete(self._cursor_key)
            else:
                pipe.set(self._cursor_key, _encode(cursor), ex=keep_seconds)
            await pipe.execute()
