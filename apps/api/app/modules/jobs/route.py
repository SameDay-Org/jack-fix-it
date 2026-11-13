"""The pro's driving route to the job's address (#351, live map part 2; Cesar 2026-11-10).

The customer's app polls it next to the pro's position (location.py) while the pro is on the
way, and draws the line. The route comes from Mapbox (app/integrations/mapbox.py).

- When there is one: the job is tracked (on the way, not checked in) and the pro has sent a
  position. Otherwise the answer is "no route", the very answer before the first position:
  like the position's read, it says nothing about the job that the job's own view does not.
- From and to: from the pro's latest position to the address of the job's request. An address
  row without coordinates (every one, until addresses are geocoded when they are made) is
  placed by Mapbox's forward geocoding, once per computed route. That answer is used and
  dropped: never written to the address, never cached on its own (Mapbox's terms for its
  temporary geocoding), never logged. An address Mapbox cannot place, or one no road leads to,
  is "no route" plus a warning with the job's id.
- The cache: a job's computed route is kept for ROUTE_CACHE_SECONDS and answered again while
  the pro is within ROUTE_REFRESH_DISTANCE_M of where it starts, so a customer's polls do not
  become as many Mapbox calls. One request at a time asks Mapbox for a job: another arriving
  meanwhile gets the route being replaced, or "no route" when there is none yet.
- Where the cache lives: a route starts at the pro's position and ends at the customer's
  address, so it follows the position's rules. It goes to the positions' own Redis only (the
  one location_guard.py checks, never the queue's, which keeps what it is given), is written
  only while the job's position is there and for no longer than that position has left, and is
  deleted with it when tracking ends (RedisJobLocationStore.delete). Nothing goes to Postgres.
- What can fail: Mapbox down, slow, refusing or without a token, or the cache unreadable, is a
  503 route_unavailable (never Mapbox's own text); the positions' store missing or refused is
  the position's own 503 location_unavailable. The pro's position is read by its own route
  and is unaffected. Logs carry the job's id and the event name: never a coordinate, an
  address or a street name.
"""

import asyncio
import logging
import math
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Final, Protocol

from fastapi import Depends
from pydantic import BaseModel, ValidationError
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from app.config import Settings, get_app_settings
from app.errors import NotFoundError
from app.integrations.mapbox import (
    Coordinate,
    DrivingRoute,
    MapboxUnavailableError,
    RouteProvider,
    StreetAddress,
)
from app.modules.jobs.errors import ProLocationUnavailableError, RouteUnavailableError
from app.modules.jobs.location import (
    KEY_PREFIX,
    JobLocationStore,
    LocationBackend,
    position_key,
    route_key,
    tracked,
    utc_now,
)
from app.modules.jobs.location_guard import EphemeralRedisGuard, LocationStoreRefusedError
from app.modules.jobs.repository import JobRepository
from app.modules.jobs.schemas import JobRoute, JobRouteOut, JobRouteStep
from app.modules.requests.service import CustomerRequestReader
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)

EARTH_RADIUS_M: Final = 6_371_008.8
_MILLISECONDS: Final = 1000

# Keeps ARGV[1] as the job's route (KEYS[2]) while the job's position (KEYS[1]) is there, for
# ARGV[2] milliseconds or what the position has left, whichever ends first. One atomic step,
# so no route is written after the delete that ends the tracking; 1 when kept, 0 when not.
_PUT_SCRIPT: Final = """
local left = redis.call('PTTL', KEYS[1])
if left <= 0 then
  return 0
end
local ttl = tonumber(ARGV[2])
if left < ttl then
  ttl = left
end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ttl)
return 1
"""


@dataclass(frozen=True)
class CachedRoute:
    """What was computed for a job from `origin`, the pro's position then: the route, or None
    when there was none to find (asked again only once the pro has moved, or it expires)."""

    origin: Coordinate
    route: JobRoute | None


class _Entry(BaseModel):
    """A CachedRoute as Redis holds it."""

    origin: tuple[float, float]  # lat, lng
    route: JobRoute | None


class JobRouteCache(Protocol):
    """The latest computed route of each job. Every call may raise RedisError or OSError
    (TimeoutError included); `get` and `put` may raise LocationStoreRefusedError when routes
    must not use the store."""

    async def get(self, job_id: uuid.UUID) -> CachedRoute | None: ...

    async def put(self, job_id: uuid.UUID, entry: CachedRoute, *, ttl_seconds: int) -> bool:
        """Keeps `entry` for `ttl_seconds` at most, and only while the job's position is
        stored. False when it was not kept."""
        ...

    async def claim(self, job_id: uuid.UUID, *, seconds: int) -> bool:
        """True for one caller per job at a time: the one that may ask the provider. The claim
        ends with `release`, or by itself after `seconds`."""
        ...

    async def release(self, job_id: uuid.UUID) -> None: ...


class RedisJobRouteCache:
    """In the positions' Redis, next to each job's position (the module doc says why). Every
    call gives up after `timeout_seconds` (TimeoutError), the check of what that Redis keeps
    included."""

    def __init__(
        self,
        redis: Redis,
        guard: EphemeralRedisGuard | None,
        *,
        timeout_seconds: float,
        prefix: str = KEY_PREFIX,
    ) -> None:
        self._redis = redis
        self._guard = guard
        self._timeout = timeout_seconds
        self._prefix = prefix
        self._put = redis.register_script(_PUT_SCRIPT)

    def key(self, job_id: uuid.UUID) -> str:
        return route_key(self._prefix, job_id)

    def claim_key(self, job_id: uuid.UUID) -> str:
        return f"{self._prefix}:route-claim:{job_id}"

    async def get(self, job_id: uuid.UUID) -> CachedRoute | None:
        async with asyncio.timeout(self._timeout):
            if self._guard is not None:
                await self._guard.require()
            raw = await self._redis.get(self.key(job_id))
        return None if raw is None else _decode(raw)

    async def put(self, job_id: uuid.UUID, entry: CachedRoute, *, ttl_seconds: int) -> bool:
        keys = [position_key(self._prefix, job_id), self.key(job_id)]
        args: list[str | int] = [_encode(entry), ttl_seconds * _MILLISECONDS]
        async with asyncio.timeout(self._timeout):
            if self._guard is not None:
                await self._guard.require()
            return bool(await self._put(keys=keys, args=args))

    async def claim(self, job_id: uuid.UUID, *, seconds: int) -> bool:
        # The claim holds no position: it needs no check of what the Redis keeps.
        async with asyncio.timeout(self._timeout):
            return bool(await self._redis.set(self.claim_key(job_id), "1", nx=True, ex=seconds))

    async def release(self, job_id: uuid.UUID) -> None:
        async with asyncio.timeout(self._timeout):
            await self._redis.delete(self.claim_key(job_id))


class NoJobRouteCache:
    """The cache where the positions' Redis is required and missing: it keeps and gives no
    route. The position's read refuses first, so this is never reached with a route."""

    async def get(self, job_id: uuid.UUID) -> CachedRoute | None:
        raise LocationStoreRefusedError("not_configured")

    async def put(self, job_id: uuid.UUID, entry: CachedRoute, *, ttl_seconds: int) -> bool:
        raise LocationStoreRefusedError("not_configured")

    async def claim(self, job_id: uuid.UUID, *, seconds: int) -> bool:
        return False

    async def release(self, job_id: uuid.UUID) -> None:
        return None


def _encode(entry: CachedRoute) -> str:
    origin = (entry.origin.lat, entry.origin.lng)
    return _Entry(origin=origin, route=entry.route).model_dump_json()


def _decode(raw: bytes | str) -> CachedRoute | None:
    """None for a value this code did not write: it is never shown, and never an error."""
    try:
        entry = _Entry.model_validate_json(raw)
    except ValidationError:
        return None
    lat, lng = entry.origin
    return CachedRoute(origin=Coordinate(lat=lat, lng=lng), route=entry.route)


def get_job_route_cache(
    request: Request, settings: Annotated[Settings, Depends(get_app_settings)]
) -> JobRouteCache:
    backend: LocationBackend | None = request.app.state.location_backend
    if backend is None:
        return NoJobRouteCache()
    return RedisJobRouteCache(
        backend.redis, backend.guard, timeout_seconds=settings.pro_location_timeout_seconds
    )


def meters_between(a: Coordinate, b: Coordinate) -> float:
    """The great-circle distance (haversine)."""
    lat_a, lat_b = math.radians(a.lat), math.radians(b.lat)
    half_lat = (lat_b - lat_a) / 2
    half_lng = math.radians(b.lng - a.lng) / 2
    h = math.sin(half_lat) ** 2 + math.cos(lat_a) * math.cos(lat_b) * math.sin(half_lng) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def thinned[T](points: Sequence[T], most: int) -> list[T]:
    """At most `most` (2 or more) of the points, evenly spread, the first and the last kept."""
    if len(points) <= most:
        return list(points)
    last = len(points) - 1
    return [points[round(index * last / (most - 1))] for index in range(most)]


@dataclass(frozen=True)
class JobRouteConfig:
    cache_seconds: int
    refresh_distance_m: float
    max_points: int
    max_steps: int
    # How long one request may hold a job's turn to ask Mapbox: both calls, and a margin.
    claim_seconds: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "JobRouteConfig":
        return cls(
            cache_seconds=settings.route_cache_seconds,
            refresh_distance_m=settings.route_refresh_distance_m,
            max_points=settings.route_max_points,
            max_steps=settings.route_max_steps,
            claim_seconds=math.ceil(2 * settings.mapbox_timeout_seconds) + 1,
        )


NO_ROUTE: Final = JobRouteOut(route=None)


class JobRouteService:
    def __init__(
        self,
        session: AsyncSession,
        config: JobRouteConfig,
        store: JobLocationStore,
        cache: JobRouteCache,
        provider: RouteProvider,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._session = session
        self._config = config
        self._store = store
        self._cache = cache
        self._provider = provider
        self._clock = clock
        self._jobs = JobRepository(session)
        self._requests = CustomerRequestReader(session)

    async def route(self, user: UserAccount, job_id: uuid.UUID) -> JobRouteOut:
        """The route of the pro of the customer's own job to its address, while the job is
        tracked and a position is fresh; NO_ROUTE otherwise (see the module doc)."""
        job = await self._jobs.get(job_id)
        if job is None or job.customer_id != user.id:
            raise NotFoundError
        is_tracked, request_id = tracked(job), job.request_id
        # Ends the read transaction: no pooled connection waits on Redis or on Mapbox.
        await self._session.commit()
        if not is_tracked:
            return NO_ROUTE
        ids = {"job_id": str(job_id)}
        try:
            position = await self._store.get(job_id)
        except LocationStoreRefusedError as refused:
            logger.error("job_route_store_refused", extra={**ids, "reason": refused.reason})
            raise ProLocationUnavailableError from None
        except (RedisError, OSError):  # OSError includes TimeoutError
            logger.error("job_route_position_unavailable", extra=ids)
            return NO_ROUTE
        if position is None:
            return NO_ROUTE
        origin = Coordinate(lat=position.lat, lng=position.lng)
        try:
            cached = await self._cache.get(job_id)
            if cached is not None and (
                meters_between(cached.origin, origin) <= self._config.refresh_distance_m
            ):
                return JobRouteOut(route=cached.route)
            claimed = await self._cache.claim(job_id, seconds=self._config.claim_seconds)
        except LocationStoreRefusedError as refused:
            logger.error("job_route_store_refused", extra={**ids, "reason": refused.reason})
            raise ProLocationUnavailableError from None
        except (RedisError, OSError):
            # Without the cache every poll would be a Mapbox call: none is made.
            logger.error("job_route_cache_unavailable", extra=ids)
            raise RouteUnavailableError from None
        if not claimed:
            # Another request is asking Mapbox for this job right now.
            return NO_ROUTE if cached is None else JobRouteOut(route=cached.route)
        try:
            route = await self._compute(job_id, request_id, origin)
            await self._keep(job_id, CachedRoute(origin=origin, route=route))
        finally:
            await self._release(job_id)
        return JobRouteOut(route=route)

    async def _compute(
        self, job_id: uuid.UUID, request_id: uuid.UUID, origin: Coordinate
    ) -> JobRoute | None:
        ids = {"job_id": str(job_id)}
        place = await self._requests.place(request_id)
        await self._session.commit()  # as above: nothing is held while Mapbox answers
        geocoded = place.lat is None or place.lng is None
        try:
            if place.lat is not None and place.lng is not None:
                destination: Coordinate | None = Coordinate(lat=place.lat, lng=place.lng)
            else:
                destination = await self._provider.geocode(
                    StreetAddress(
                        line1=place.line1,
                        city=place.city,
                        state=place.state,
                        zip_code=place.zip_code,
                    )
                )
            if destination is None:
                logger.warning("job_route_no_destination", extra=ids)
                return None
            found = await self._provider.route(origin, destination)
        except MapboxUnavailableError:
            # The wrapper logged what failed; the request id ties it to this job's request.
            raise RouteUnavailableError from None
        if found is None:
            logger.warning("job_route_not_found", extra=ids)
            return None
        logger.info("job_route_computed", extra={**ids, "geocoded": geocoded})
        return self._shaped(found)

    def _shaped(self, found: DrivingRoute) -> JobRoute:
        """The provider's route as the app gets it: the line thinned, the first streets only."""
        return JobRoute(
            geometry=[
                (point.lng, point.lat) for point in thinned(found.geometry, self._config.max_points)
            ],
            distance_m=found.distance_m,
            duration_s=found.duration_s,
            steps=[
                JobRouteStep(
                    street_name=step.street_name or None,
                    distance_m=step.distance_m,
                    duration_s=step.duration_s,
                )
                for step in found.steps[: self._config.max_steps]
            ],
            computed_at=self._clock(),
        )

    async def _keep(self, job_id: uuid.UUID, entry: CachedRoute) -> None:
        """A route that cannot be kept is still answered: it was paid for."""
        try:
            await self._cache.put(job_id, entry, ttl_seconds=self._config.cache_seconds)
        except LocationStoreRefusedError as refused:
            logger.error(
                "job_route_store_refused", extra={"job_id": str(job_id), "reason": refused.reason}
            )
        except (RedisError, OSError):
            logger.error("job_route_cache_unavailable", extra={"job_id": str(job_id)})

    async def _release(self, job_id: uuid.UUID) -> None:
        """A claim that cannot be released ends by itself (JobRouteConfig.claim_seconds)."""
        try:
            await self._cache.release(job_id)
        except (RedisError, OSError):
            logger.error("job_route_cache_unavailable", extra={"job_id": str(job_id)})
