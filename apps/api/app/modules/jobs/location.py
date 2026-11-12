"""The pro's live position while on the way (#350, live map part 1; Cesar 2026-11-10).

The pro's app sends its position every ~10 s while the job is on the way, and the customer's app
reads the latest one. Both sides poll; there is no history.

- Where it lives: Redis only, one hash per job under `<prefix>:<job id>`, holding the latest
  position alone, for PRO_LOCATION_TTL_SECONDS after its write. Nothing goes to Postgres. Logs
  and error bodies carry ids and the event name, never a coordinate.
- Which Redis: one of the positions' own (LOCATION_REDIS_URL) that keeps nothing but its live
  keys, so the expiry and the delete are the whole retention; location_guard.py checks it and
  says what happens otherwise. Development and test use REDIS_URL's. A store that is missing
  or refused answers 503 location_unavailable to the ping and to the read; a delete is never
  refused.
- Tracking is the time between On my way and the check-in: the job is on_the_way and the pro has
  not checked in. Outside it a ping is refused (409 not_on_the_way) and the customer reads "no
  position", the very answer they get before the first ping: the read says nothing about the
  job that the job's own view does not.
- The end of tracking deletes the position: the check-in (JobExecutionService.check_in) and
  every status change out of on_the_way (JobStateMachine.transition) delete it under the job's
  row lock, before they commit. A ping holds the row FOR SHARE from its check of the job to its
  write, so it either ends before that lock is taken, and what it wrote is deleted, or waits
  for the commit and is refused: no position outlives tracking. A delete Redis refuses is logged
  and never fails the step; the position is unreadable from then on (both routes look at the
  job first) and expires on its own.
- A ping is kept only when it is news, decided in Redis in one step (two pings of a job may
  race): one arriving less than PRO_LOCATION_MIN_INTERVAL_SECONDS after the stored one was
  written, or taken by the device before the stored one (`recorded_at`), is answered 204 and
  dropped. The pro's background task never gets an error for sending too often; a flood is cut
  by the per-pro rate limit instead (429, the router's).
- `recorded_at` is the device's clock, checked against the server's: more than
  PRO_LOCATION_MAX_FUTURE_SECONDS ahead or PRO_LOCATION_MAX_AGE_SECONDS behind is a 422. The
  customer gets `updated_at`, the server's time of the write, never the device's.
- Redis down, or slower than PRO_LOCATION_TIMEOUT_SECONDS: the ping answers 503
  location_unavailable (the app drops it and sends the next), the read answers "no position".
"""

import asyncio
import json
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Final, Protocol

from fastapi import Depends
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from app.config import LOCATION_REDIS_REQUIRED_IN, Settings, get_app_settings
from app.errors import NotFoundError
from app.modules.jobs.errors import NotOnTheWayError, ProLocationUnavailableError
from app.modules.jobs.location_guard import EphemeralRedisGuard, LocationStoreRefusedError
from app.modules.jobs.models import Job, JobStatus
from app.modules.jobs.repository import JobRepository
from app.modules.jobs.schemas import ProLocationIn, ProLocationOut, ProPosition
from app.modules.pros.service import ProService
from app.modules.requests.errors import InvalidRequestError
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)

KEY_PREFIX: Final = "jobloc"
_EPOCH: Final = datetime(1970, 1, 1, tzinfo=UTC)
_MICROSECOND: Final = timedelta(microseconds=1)

# Keeps ARGV[1] as the job's position unless the stored one was written less than ARGV[4]
# microseconds before ARGV[3] (now), or was taken by the device after ARGV[2]. One atomic step;
# 1 when kept, 0 when dropped (nothing changes, the stored one's expiry included).
_PUT_SCRIPT: Final = """
local stored = redis.call('HMGET', KEYS[1], 'recorded', 'updated')
if stored[1] and stored[2] then
  if tonumber(ARGV[3]) - tonumber(stored[2]) < tonumber(ARGV[4]) then
    return 0
  end
  if tonumber(ARGV[2]) < tonumber(stored[1]) then
    return 0
  end
end
redis.call('HSET', KEYS[1], 'position', ARGV[1], 'recorded', ARGV[2], 'updated', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[5])
return 1
"""


@dataclass(frozen=True)
class Position:
    """`recorded_at` is the device's time of the fix, `updated_at` the server's of the write;
    both UTC."""

    lat: float
    lng: float
    accuracy_m: float | None
    heading_deg: float | None
    recorded_at: datetime
    updated_at: datetime


class JobLocationStore(Protocol):
    """The latest position of each job. Every call may raise RedisError or OSError (TimeoutError
    included) when the store is down or slow; `put` and `get` may raise
    LocationStoreRefusedError when positions must not use it."""

    async def put(
        self, job_id: uuid.UUID, position: Position, *, min_interval: timedelta, ttl_seconds: int
    ) -> bool:
        """Keeps `position` as the job's only one for `ttl_seconds`. False, and nothing changes,
        when the stored one was written less than `min_interval` before it or was recorded
        after it."""
        ...

    async def get(self, job_id: uuid.UUID) -> Position | None: ...

    async def delete(self, job_id: uuid.UUID) -> None: ...


class RedisJobLocationStore:
    """Every call gives up after `timeout_seconds` (TimeoutError): a hung Redis must not hang a
    ping, a read or a job step."""

    def __init__(self, redis: Redis, *, timeout_seconds: float, prefix: str = KEY_PREFIX) -> None:
        self._redis = redis
        self._timeout = timeout_seconds
        self._prefix = prefix
        self._put = redis.register_script(_PUT_SCRIPT)

    def key(self, job_id: uuid.UUID) -> str:
        return f"{self._prefix}:{job_id}"

    async def put(
        self, job_id: uuid.UUID, position: Position, *, min_interval: timedelta, ttl_seconds: int
    ) -> bool:
        args: list[str | int] = [
            _encode(position),
            _micros(position.recorded_at),
            _micros(position.updated_at),
            min_interval // _MICROSECOND,
            ttl_seconds,
        ]
        async with asyncio.timeout(self._timeout):
            return bool(await self._put(keys=[self.key(job_id)], args=args))

    async def get(self, job_id: uuid.UUID) -> Position | None:
        async with asyncio.timeout(self._timeout):
            # redis-py types hget as `Awaitable | value` for its sync and async clients alike;
            # on redis.asyncio it is always awaitable.
            raw = await self._redis.hget(self.key(job_id), "position")  # type: ignore[misc]
        return None if raw is None else _decode(raw)

    async def delete(self, job_id: uuid.UUID) -> None:
        async with asyncio.timeout(self._timeout):
            await self._redis.delete(self.key(job_id))


def _micros(moment: datetime) -> int:
    return (moment - _EPOCH) // _MICROSECOND


def _encode(position: Position) -> str:
    return json.dumps(
        {
            "lat": position.lat,
            "lng": position.lng,
            "accuracy_m": position.accuracy_m,
            "heading_deg": position.heading_deg,
            "recorded_at": _micros(position.recorded_at),
            "updated_at": _micros(position.updated_at),
        }
    )


def _decode(raw: bytes | str) -> Position | None:
    """None for a value this code did not write: it is never shown, and never an error."""
    try:
        data = json.loads(raw)
        return Position(
            lat=float(data["lat"]),
            lng=float(data["lng"]),
            accuracy_m=None if data["accuracy_m"] is None else float(data["accuracy_m"]),
            heading_deg=None if data["heading_deg"] is None else float(data["heading_deg"]),
            recorded_at=_EPOCH + int(data["recorded_at"]) * _MICROSECOND,
            updated_at=_EPOCH + int(data["updated_at"]) * _MICROSECOND,
        )
    except (ValueError, KeyError, TypeError, OverflowError):
        return None


class GuardedJobLocationStore:
    """`inner`, behind the check that its Redis keeps nothing (location_guard.py): no position
    goes into, or comes out of, one that may keep it. A delete is never refused: it carries no
    position and only removes one. The check and the operation share one `timeout_seconds`, so
    a call still gives up after it."""

    def __init__(
        self, inner: JobLocationStore, guard: EphemeralRedisGuard, *, timeout_seconds: float
    ) -> None:
        self._inner = inner
        self._guard = guard
        self._timeout = timeout_seconds

    async def put(
        self, job_id: uuid.UUID, position: Position, *, min_interval: timedelta, ttl_seconds: int
    ) -> bool:
        async with asyncio.timeout(self._timeout):
            await self._guard.require()
            return await self._inner.put(
                job_id, position, min_interval=min_interval, ttl_seconds=ttl_seconds
            )

    async def get(self, job_id: uuid.UUID) -> Position | None:
        async with asyncio.timeout(self._timeout):
            await self._guard.require()
            return await self._inner.get(job_id)

    async def delete(self, job_id: uuid.UUID) -> None:
        await self._inner.delete(job_id)


class NoJobLocationStore:
    """The store where LOCATION_REDIS_URL is required and missing: it takes and gives no
    position. Nothing was written, so a delete has nothing to remove."""

    async def put(
        self, job_id: uuid.UUID, position: Position, *, min_interval: timedelta, ttl_seconds: int
    ) -> bool:
        raise LocationStoreRefusedError("not_configured")

    async def get(self, job_id: uuid.UUID) -> Position | None:
        raise LocationStoreRefusedError("not_configured")

    async def delete(self, job_id: uuid.UUID) -> None:
        return None


@dataclass(frozen=True)
class LocationBackend:
    """The positions' Redis and the check of what it keeps: made once at startup (app.main),
    kept on the app's state, so the check's answer is shared by every request."""

    redis: Redis
    guard: EphemeralRedisGuard


def location_backend(settings: Settings, shared: Redis) -> LocationBackend | None:
    """LOCATION_REDIS_URL's Redis. Without the setting: the app's own Redis (`shared`) in
    development and test, and None in staging and production, where positions never share the
    Redis that the queue needs durable."""
    required = settings.app_env in LOCATION_REDIS_REQUIRED_IN
    if settings.location_redis_url is not None:
        redis: Redis = Redis.from_url(settings.location_redis_url)
    elif required:
        return None
    else:
        redis = shared
    guard = EphemeralRedisGuard(
        redis,
        enforce=required,
        assume_ephemeral=settings.location_redis_assume_ephemeral,
        recheck_seconds=settings.location_redis_recheck_seconds,
    )
    return LocationBackend(redis, guard)


def get_job_location_store(
    request: Request, settings: Annotated[Settings, Depends(get_app_settings)]
) -> JobLocationStore:
    backend: LocationBackend | None = request.app.state.location_backend
    if backend is None:
        return NoJobLocationStore()
    timeout = settings.pro_location_timeout_seconds
    store = RedisJobLocationStore(backend.redis, timeout_seconds=timeout)
    return GuardedJobLocationStore(store, backend.guard, timeout_seconds=timeout)


async def forget_position(store: JobLocationStore | None, job_id: uuid.UUID) -> None:
    """Deletes the job's position when its tracking ends. A store that fails is logged with the
    job's id and never raised: the step that ends the tracking goes on, and the position, which
    no route shows any more, expires on its own.

    Without a store there is nothing to end the tracking with, and that is an error: whatever
    checks a pro in, or moves a job out of on_the_way, is built with the store."""
    if store is None:
        raise RuntimeError("ending a job's tracking needs the location store")
    try:
        await store.delete(job_id)
    except (RedisError, OSError):  # OSError includes TimeoutError
        logger.error("pro_location_delete_failed", extra={"job_id": str(job_id)})


def tracked(job: Job) -> bool:
    """Whether the pro's position is followed: on the way, and not arrived (checked in) yet."""
    return job.status is JobStatus.ON_THE_WAY and job.checked_in_at is None


def utc_now() -> datetime:
    return datetime.now(UTC)


def get_location_clock() -> Callable[[], datetime]:
    """FastAPI dependency: the server's clock for positions (a fixed one in tests)."""
    return utc_now


@dataclass(frozen=True)
class ProLocationConfig:
    ttl_seconds: int
    min_interval: timedelta
    max_future: timedelta
    max_age: timedelta

    @classmethod
    def from_settings(cls, settings: Settings) -> "ProLocationConfig":
        return cls(
            ttl_seconds=settings.pro_location_ttl_seconds,
            min_interval=timedelta(seconds=settings.pro_location_min_interval_seconds),
            max_future=timedelta(seconds=settings.pro_location_max_future_seconds),
            max_age=timedelta(seconds=settings.pro_location_max_age_seconds),
        )


NO_POSITION: Final = ProLocationOut(position=None)


class ProLocationService:
    def __init__(
        self,
        session: AsyncSession,
        config: ProLocationConfig,
        store: JobLocationStore,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._session = session
        self._config = config
        self._store = store
        self._clock = clock
        self._jobs = JobRepository(session)
        self._pros = ProService(session)

    async def ping(self, user: UserAccount, job_id: uuid.UUID, data: ProLocationIn) -> None:
        """The pro's position on their own job while it is tracked (see the module doc)."""
        now = self._clock()
        # Compared as given: converting a time at the edge of the calendar to UTC overflows.
        if not now - self._config.max_age <= data.recorded_at <= now + self._config.max_future:
            raise InvalidRequestError
        pro_id = await self._pros.get_profile_id_for_user(user.id)
        if pro_id is None:  # no profile: no job was ever theirs
            raise NotFoundError
        # Another pro's job is no row here, like a job that does not exist: never locked.
        job = await self._jobs.get_of_pro_for_share(job_id, pro_id)
        if job is None:
            raise NotFoundError
        if not tracked(job):
            raise NotOnTheWayError
        ids = {"job_id": str(job.id), "pro_id": str(pro_id)}
        position = Position(
            lat=data.lat,
            lng=data.lng,
            accuracy_m=data.accuracy_m,
            heading_deg=data.heading_deg,
            recorded_at=data.recorded_at.astimezone(UTC),
            updated_at=now,
        )
        try:
            # Under the row's share lock (the module doc says why), for at most the store's
            # timeout.
            kept = await self._store.put(
                job.id,
                position,
                min_interval=self._config.min_interval,
                ttl_seconds=self._config.ttl_seconds,
            )
        except LocationStoreRefusedError as refused:
            logger.error("pro_location_refused", extra={**ids, "reason": refused.reason})
            raise ProLocationUnavailableError from None
        except (RedisError, OSError):  # OSError includes TimeoutError
            logger.error("pro_location_unavailable", extra=ids)
            raise ProLocationUnavailableError from None
        await self._session.commit()  # nothing changed: ends the transaction and its lock
        logger.debug("pro_location_updated" if kept else "pro_location_ignored", extra=ids)

    async def last_position(self, user: UserAccount, job_id: uuid.UUID) -> ProLocationOut:
        """The latest position of the pro of the customer's own job, while it is tracked and a
        ping is fresh; NO_POSITION otherwise, whatever the reason. A store that is missing or
        refused is the one error: the app can tell it from "no position yet"."""
        job = await self._jobs.get(job_id)
        if job is None or job.customer_id != user.id:
            raise NotFoundError
        is_tracked = tracked(job)
        # Ends the read transaction: no pooled connection waits on Redis.
        await self._session.commit()
        if not is_tracked:
            return NO_POSITION
        try:
            position = await self._store.get(job_id)
        except LocationStoreRefusedError as refused:
            logger.error(
                "pro_location_refused", extra={"job_id": str(job_id), "reason": refused.reason}
            )
            raise ProLocationUnavailableError from None
        except (RedisError, OSError):  # OSError includes TimeoutError
            logger.error("pro_location_unavailable", extra={"job_id": str(job_id)})
            return NO_POSITION
        if position is None:
            return NO_POSITION
        return ProLocationOut(
            position=ProPosition(
                lat=position.lat,
                lng=position.lng,
                accuracy_m=position.accuracy_m,
                heading_deg=position.heading_deg,
                updated_at=position.updated_at,
            )
        )
