"""The pro's driving route to the job's address (#351, live map part 2; Cesar 2026-11-10).

The customer's app polls it next to the pro's position (location.py) while the pro is on the
way, and draws the line. The route comes from Mapbox (app/integrations/mapbox.py).

- When there is one: the job is tracked (on the way, not checked in) and the pro has sent a
  position. Otherwise the answer is "no route", the very answer before the first position:
  like the position's read, it says nothing about the job that the job's own view does not.
- From and to: from the pro's latest position to the address of the job's request. An address
  row that has its point (GEOCODE_ON_SAVE, addresses/geocode.py, #384) is routed to as it
  is: no geocoding call. A row without one (every one while that switch is off, and one
  whose geocoding kept nothing) is placed by Mapbox's forward geocoding, once per computed
  route. That answer is used and dropped: never written to the address, never cached on its
  own (Mapbox's terms for its temporary geocoding), never logged. An address Mapbox cannot
  place, or one no road leads to, is "no route" plus a warning with the job's id.
- The cache: a job's computed route is kept for ROUTE_CACHE_SECONDS and answered again while
  the pro is within ROUTE_REFRESH_DISTANCE_M of where it starts, so a customer's polls do not
  become as many Mapbox calls. One request at a time asks Mapbox for a job: another arriving
  meanwhile gets the route being replaced, or "no route" when there is none yet. The request
  whose turn it is looks at the cache once more before it asks: one that had the turn since
  its first look may have kept the very route it was about to pay for. A turn is held for as
  long as every step made in it may take (turn_seconds) and carries its request's own token:
  a request ends its own turn only, never one that passed to another. After a failure Mapbox
  is not asked again for that job for ROUTE_RETRY_SECONDS: polls meanwhile get the same 503,
  so an app that tries again at once, or a rate limit, is not answered with more calls.
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
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Final, Literal, Protocol

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
from app.modules.addresses.service import AddressPlace
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


# Ends a turn: deletes the job's claim (KEYS[1]) only while it holds ARGV[1], the token of the
# request ending it. A turn that ended by itself and is another request's now is left alone.
_RELEASE_SCRIPT: Final = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""

# After the provider failed: the job's claim (KEYS[1]) becomes ARGV[2], nobody's turn, for
# ARGV[3] seconds. Not while it holds anything but ARGV[1], the token of the request that
# failed: another request's turn, or a wait already begun, stays as it is. 1 when written.
_HOLD_OFF_SCRIPT: Final = """
local holder = redis.call('GET', KEYS[1])
if holder and holder ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
"""


# A job's turn to ask the provider, as `claim` finds it: the caller's own now, another
# request's, or nobody's for a while after the provider failed.
Turn = Literal["mine", "taken", "held_off"]
# What the claim holds instead of a request's token while nobody may ask (never a token: those
# are 32 hex digits).
_HELD_OFF: Final = "held-off"

# What a request does with a job's turn held, each step under its own deadline: the cache
# answers the claim, is looked at again, keeps the route and ends the turn (the cache's
# deadline each); Mapbox places the address and gives the directions (Mapbox's deadline each).
_CACHE_STEPS_IN_A_TURN: Final = 4
_MAPBOX_CALLS_IN_A_TURN: Final = 2
# For what runs between those steps.
_TURN_MARGIN_SECONDS: Final = 1


def turn_seconds(*, mapbox_timeout_seconds: float, cache_timeout_seconds: float) -> int:
    """How long Redis holds a job's turn for one request. Redis counts from the moment it
    takes the claim, before its answer is back, so the time covers every step from there to
    the end of the turn, each as slow as its deadline lets it be: a turn that ended sooner
    would let a second request ask Mapbox while the first still works."""
    steps = (
        _MAPBOX_CALLS_IN_A_TURN * mapbox_timeout_seconds
        + _CACHE_STEPS_IN_A_TURN * cache_timeout_seconds
    )
    return math.ceil(steps) + _TURN_MARGIN_SECONDS


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

    async def claim(self, job_id: uuid.UUID, *, token: str, seconds: int) -> Turn:
        """`mine` for one caller per job at a time: the one that may ask the provider. `token`
        names that caller's turn and no other's. The turn ends with `release` or `hold_off`,
        or by itself after `seconds`."""
        ...

    async def release(self, job_id: uuid.UUID, *, token: str) -> None:
        """Ends the turn taken with `token`, and only that one: a turn that ended by itself
        and is another caller's now stays."""
        ...

    async def hold_off(self, job_id: uuid.UUID, *, token: str, seconds: int) -> None:
        """Ends the turn taken with `token` and gives nobody the next one for `seconds`. A
        turn that is another caller's now stays as it is."""
        ...


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
        self._release = redis.register_script(_RELEASE_SCRIPT)
        self._hold_off = redis.register_script(_HOLD_OFF_SCRIPT)

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

    async def claim(self, job_id: uuid.UUID, *, token: str, seconds: int) -> Turn:
        # The claim holds the caller's token, no position: it needs no check of what the
        # Redis keeps.
        key = self.claim_key(job_id)
        async with asyncio.timeout(self._timeout):
            if await self._redis.set(key, token, nx=True, ex=seconds):
                return "mine"
            holder = await self._redis.get(key)
        return "held_off" if holder == _HELD_OFF.encode() else "taken"

    async def release(self, job_id: uuid.UUID, *, token: str) -> None:
        async with asyncio.timeout(self._timeout):
            await self._release(keys=[self.claim_key(job_id)], args=[token])

    async def hold_off(self, job_id: uuid.UUID, *, token: str, seconds: int) -> None:
        args: list[str | int] = [token, _HELD_OFF, seconds]
        async with asyncio.timeout(self._timeout):
            await self._hold_off(keys=[self.claim_key(job_id)], args=args)


class NoJobRouteCache:
    """The cache where the positions' Redis is required and missing: it keeps and gives no
    route. The position's read refuses first, so this is never reached with a route."""

    async def get(self, job_id: uuid.UUID) -> CachedRoute | None:
        raise LocationStoreRefusedError("not_configured")

    async def put(self, job_id: uuid.UUID, entry: CachedRoute, *, ttl_seconds: int) -> bool:
        raise LocationStoreRefusedError("not_configured")

    async def claim(self, job_id: uuid.UUID, *, token: str, seconds: int) -> Turn:
        return "taken"

    async def release(self, job_id: uuid.UUID, *, token: str) -> None:
        return None

    async def hold_off(self, job_id: uuid.UUID, *, token: str, seconds: int) -> None:
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
    # How long one request may hold a job's turn to ask Mapbox (turn_seconds).
    claim_seconds: int
    # How long nobody asks Mapbox for a job after it failed.
    retry_seconds: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "JobRouteConfig":
        return cls(
            cache_seconds=settings.route_cache_seconds,
            refresh_distance_m=settings.route_refresh_distance_m,
            max_points=settings.route_max_points,
            max_steps=settings.route_max_steps,
            # The deadlines the provider and the cache are built with (get_route_provider,
            # get_job_route_cache).
            claim_seconds=turn_seconds(
                mapbox_timeout_seconds=settings.mapbox_timeout_seconds,
                cache_timeout_seconds=settings.pro_location_timeout_seconds,
            ),
            retry_seconds=settings.route_retry_seconds,
        )


NO_ROUTE: Final = JobRouteOut(route=None)


@contextmanager
def _cache_failures(ids: dict[str, str]) -> Iterator[None]:
    """A cache that cannot be used, as the route's answer: the position's own 503 when routes
    must not use that Redis, 503 route_unavailable when it does not answer."""
    try:
        yield
    except LocationStoreRefusedError as refused:
        logger.error("job_route_store_refused", extra={**ids, "reason": refused.reason})
        raise ProLocationUnavailableError from None
    except (RedisError, OSError):  # OSError includes TimeoutError
        # Without the cache every poll would be a Mapbox call: none is made.
        logger.error("job_route_cache_unavailable", extra=ids)
        raise RouteUnavailableError from None


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
        # This request's turn, should it get one: no other request ends it, and it ends no
        # other's (a turn that outlived its time is the next request's by then).
        token = uuid.uuid4().hex
        with _cache_failures(ids):
            cached = await self._cache.get(job_id)
            if (answer := self._kept_answer(cached, origin)) is not None:
                return answer
            # Read before the turn is taken: the turn's time is Mapbox's and the cache's only.
            place = await self._requests.place(request_id)
            await self._session.commit()  # as above: nothing is held while Mapbox answers
            turn = await self._cache.claim(job_id, token=token, seconds=self._config.claim_seconds)
        if turn == "held_off":
            # Mapbox failed for this job a moment ago: it is not asked again yet.
            raise RouteUnavailableError
        if turn == "taken":
            # Another request is asking Mapbox for this job right now.
            return NO_ROUTE if cached is None else JobRouteOut(route=cached.route)
        failed = False
        try:
            # The first look is old by now: a request that had the turn since may have kept
            # the route this one was about to ask Mapbox for. With the turn held nobody else
            # keeps one, so this look is the one to decide on. Every way out of here gives
            # the turn back (the `finally`).
            with _cache_failures(ids):
                cached = await self._cache.get(job_id)
            if (answer := self._kept_answer(cached, origin)) is not None:
                return answer
            try:
                route = await self._compute(job_id, place, origin)
            except RouteUnavailableError:
                failed = True  # Mapbox's failure only: a cache that fails holds nobody off
                raise
            await self._keep(job_id, CachedRoute(origin=origin, route=route))
        finally:
            await self._end_turn(job_id, token, failed=failed)
        return JobRouteOut(route=route)

    def _kept_answer(self, kept: CachedRoute | None, origin: Coordinate) -> JobRouteOut | None:
        """The kept route as the answer while the pro, at `origin`, is within the refresh
        distance of where it starts; None when Mapbox is to be asked."""
        if kept is not None and (
            meters_between(kept.origin, origin) <= self._config.refresh_distance_m
        ):
            return JobRouteOut(route=kept.route)
        return None

    async def _compute(
        self, job_id: uuid.UUID, place: AddressPlace, origin: Coordinate
    ) -> JobRoute | None:
        ids = {"job_id": str(job_id)}
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

    async def _end_turn(self, job_id: uuid.UUID, token: str, *, failed: bool) -> None:
        """Gives the turn taken with `token` back, or, after Mapbox failed, to nobody for a
        while. A turn that cannot be ended ends by itself (JobRouteConfig.claim_seconds)."""
        try:
            if failed:
                await self._cache.hold_off(job_id, token=token, seconds=self._config.retry_seconds)
            else:
                await self._cache.release(job_id, token=token)
        except (RedisError, OSError):
            logger.error("job_route_cache_unavailable", extra={"job_id": str(job_id)})
