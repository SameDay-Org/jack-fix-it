"""The Redis that holds the pros' live positions must keep nothing but its live keys (#350).

A position is gone once its key is deleted or expires only if Redis wrote it nowhere else.
Three settings of a Redis server keep what went through it:

- `save`: RDB snapshots write every key to disk, and to whatever backs that disk up.
- `appendonly`: the AOF writes every command, so each position a job ever had.
- `slowlog-log-slower-than`: the slow log keeps a slow command with its arguments, and a
  position is an argument of the store's write. A negative value turns it off; 0 logs every
  command.

So the positions get a Redis of their own (LOCATION_REDIS_URL) with all three off, and the API
asks it (CONFIG GET) before a position goes in or comes out, again once the answer is
LOCATION_REDIS_RECHECK_SECONDS old. What it does with the answer:

- It keeps something (`not_ephemeral`): refused. LOCATION_REDIS_ASSUME_EPHEMERAL never
  overrides an answer.
- It will not say (`unverifiable`): CONFIG is refused, as on a managed Redis or under an ACL,
  or a value is missing or unreadable. Refused, unless LOCATION_REDIS_ASSUME_EPHEMERAL is true:
  the deployer's word that this Redis keeps nothing.
- It cannot be reached: the error goes to the caller like any other Redis outage, and nothing
  is remembered.

Refusing is for staging and production (`enforce`). Development and test run on the shared
local Redis, which keeps snapshots: there the answer is only logged.

What the check cannot see is the deployer's to keep (docs/railway.md): no volume, no backup and
no replica on that Redis service.
"""

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Literal

from redis.asyncio import Redis
from redis.exceptions import ResponseError

logger = logging.getLogger(__name__)

Refusal = Literal["not_configured", "not_ephemeral", "unverifiable"]

SAVE: Final = "save"
APPEND_ONLY: Final = "appendonly"
SLOW_LOG: Final = "slowlog-log-slower-than"
CHECKED_SETTINGS: Final = (SAVE, APPEND_ONLY, SLOW_LOG)

_EVENTS: Final[dict[Refusal, str]] = {
    "not_ephemeral": "location_redis_not_ephemeral",
    "unverifiable": "location_redis_unverifiable",
}


class LocationStoreRefusedError(Exception):
    """No position may go into, or come out of, the store; `reason` says why. It carries
    nothing else."""

    def __init__(self, reason: Refusal) -> None:
        super().__init__(reason)
        self.reason: Final = reason


@dataclass(frozen=True)
class _Verdict:
    refusal: Refusal | None
    unsafe: tuple[str, ...]  # settings that keep what goes through the server
    unreadable: tuple[str, ...]  # settings the server did not give


def _text(value: object) -> str | None:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value if isinstance(value, str) else None


def _setting(reply: object, name: str) -> str | None:
    """The value of `name` in a CONFIG GET reply; None when the reply does not have it."""
    if not isinstance(reply, dict):
        return None
    for key, value in reply.items():
        if _text(key) == name:
            return _text(value)
    return None


def _keeps_nothing(name: str, value: str) -> bool:
    """Whether a server whose `name` is `value` keeps nothing through it. ValueError when the
    slow log's threshold is not a number."""
    if name == SAVE:
        return value.strip() == ""
    if name == APPEND_ONLY:
        return value.strip().lower() == "no"
    return int(value) < 0


class EphemeralRedisGuard:
    """Asks `redis` what it keeps and remembers the answer for `recheck_seconds`.

    `require` never waits longer than its caller lets it: there is no timeout here.
    """

    def __init__(
        self,
        redis: Redis,
        *,
        enforce: bool,
        assume_ephemeral: bool,
        recheck_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._redis = redis
        self._enforce = enforce
        self._assume_ephemeral = assume_ephemeral
        self._recheck = recheck_seconds
        self._clock = clock
        self._verdict: _Verdict | None = None
        self._asked_at = 0.0
        self._asking = asyncio.Lock()

    @property
    def enforce(self) -> bool:
        return self._enforce

    async def require(self) -> None:
        """Returns when positions may use the Redis. Raises LocationStoreRefusedError when it
        keeps them or will not say (where that is enforced), and RedisError or OSError when
        it cannot be asked."""
        verdict = self._remembered()
        if verdict is None:
            async with self._asking:
                verdict = self._remembered()  # another request may have asked meanwhile
                if verdict is None:
                    verdict = await self._ask()
                    if verdict != self._verdict:  # said once, and again when it changes
                        self._log(verdict)
                    self._verdict, self._asked_at = verdict, self._clock()
        if self._enforce and verdict.refusal is not None:
            raise LocationStoreRefusedError(verdict.refusal)

    def _remembered(self) -> _Verdict | None:
        if self._verdict is None or self._clock() - self._asked_at >= self._recheck:
            return None
        return self._verdict

    async def _ask(self) -> _Verdict:
        unsafe: list[str] = []
        unreadable: list[str] = []
        for name in CHECKED_SETTINGS:
            try:
                # One parameter per command: every Redis version takes it.
                reply = await self._redis.config_get(name)
            except ResponseError:
                # The server refuses CONFIG (a managed Redis, an ACL). Its text is not logged.
                unreadable.append(name)
                continue
            value = _setting(reply, name)
            try:
                if value is None:
                    unreadable.append(name)
                elif not _keeps_nothing(name, value):
                    unsafe.append(name)
            except ValueError:
                unreadable.append(name)
        refusal: Refusal | None = None
        if unsafe:
            refusal = "not_ephemeral"
        elif unreadable and not self._assume_ephemeral:
            refusal = "unverifiable"
        return _Verdict(refusal, tuple(unsafe), tuple(unreadable))

    def _log(self, verdict: _Verdict) -> None:
        """The settings' names only: no value of the server's, and no position, is logged."""
        extra = {
            "unsafe": list(verdict.unsafe),
            "unreadable": list(verdict.unreadable),
            "enforced": self._enforce,
        }
        if verdict.refusal is not None:
            level = logging.ERROR if self._enforce else logging.WARNING
            logger.log(level, _EVENTS[verdict.refusal], extra=extra)
        elif verdict.unreadable:
            logger.warning("location_redis_assumed_ephemeral", extra=extra)
        else:
            logger.info("location_redis_ephemeral", extra=extra)
