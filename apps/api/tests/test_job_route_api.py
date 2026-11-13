"""The pro's route to the job's address (#351): GET /v1/jobs/{job_id}/route (customer).

Mapbox is a fake that records its calls, or the real client on a mock transport: never the
network. Positions and cached routes live in the real Redis of REDIS_URL under a prefix of the
test's own, deleted afterwards; the server's clock is fixed (`clock`), and a test moves it.
"""

import asyncio
import json
import logging
import re
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import pytest
import sentry_sdk
from fastapi import FastAPI
from redis.asyncio import Redis
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from app.config import Settings
from app.db import get_session
from app.integrations.mapbox import (
    Coordinate,
    DrivingRoute,
    MapboxRouteProvider,
    MapboxUnavailableError,
    RouteStep,
    StreetAddress,
    get_route_provider,
)
from app.modules.addresses.models import Address
from app.modules.addresses.service import AddressPlace
from app.modules.jobs.location import (
    LocationBackend,
    NoJobLocationStore,
    RedisJobLocationStore,
    get_job_location_store,
    get_location_clock,
    location_backend,
)
from app.modules.jobs.location_guard import LocationStoreRefusedError
from app.modules.jobs.models import JobStatus
from app.modules.jobs.route import (
    CachedRoute,
    JobRouteConfig,
    NoJobRouteCache,
    RedisJobRouteCache,
    Turn,
    get_job_route_cache,
    meters_between,
    thinned,
)
from app.modules.requests.service import CustomerRequestReader
from app.observability import MAPBOX_URL_LABEL
from tests.conftest import (
    InMemoryJobRouteCache,
    _rolled_back_session,
    make_app,
    make_settings,
)
from tests.helpers import log_fields, unclocked_fields
from tests.job_world import LINE1, LINE2, JobWorld, Party, build_world, make_job, record_pushes
from tests.test_pro_location_api import (
    CODE,
    FORBIDDEN,
    LAT,
    LNG,
    NOT_FOUND,
    NOT_TRACKED,
    NOW,
    STORE_TIMEOUT,
    TTL,
    clock,
    dead_redis,
    on_the_way_job,
    plant,
    position,
    prefix,
    redis,
    settings,
    store,
)
from tests.test_pro_location_api import UNAVAILABLE as LOCATION_UNAVAILABLE
from tests.test_pro_location_retention import SNAPSHOTS, ConfigOnly, guard_on
from tests.test_requests_api import RecordingQueue
from tests.test_saved_addresses_api import counted_statements
from tests.test_sentry_scrubbing import TEST_DSN, MemoryTransport, _payloads, sentry_transport

# Fixtures, used by name.
__all__ = ["clock", "dead_redis", "prefix", "redis", "sentry_transport", "settings", "store"]

ROUTE_LOGGER = "app.modules.jobs.route"
MAPBOX_LOGGER = "app.integrations.mapbox"
TOKEN = "pk.test-mapbox-token-not-real"
HOST = "api.mapbox.com"
VENDOR_TEXT = "Mapbox says: probe-vendor-message"
STREET = "Probe Road"
# Where the address is when its row says so, and where the fake geocoder puts it: like the
# pro's (LAT, LNG), coordinates no id, time or other number of a log line looks like.
DEST_LAT, DEST_LNG = 26.234568, -80.254321
GEO_LAT, GEO_LNG = 26.345679, -80.365432
ORIGIN = Coordinate(lat=LAT, lng=LNG)
DESTINATION = Coordinate(lat=DEST_LAT, lng=DEST_LNG)
GEOCODED = Coordinate(lat=GEO_LAT, lng=GEO_LNG)
# One degree of latitude is about 111.2 km: steps of 60 m and 120 m north.
NORTH_60_M, NORTH_120_M = 0.00054, 0.00108
# The token, the vendor's host and text, every position, the address and the street names. The
# ZIP is no needle: five digits can turn up in a log line's own timestamp or in an id.
NEEDLES = (
    TOKEN,
    HOST,
    "probe-vendor-message",
    "26.1234",
    "80.1432",
    "26.2345",
    "80.2543",
    "26.3456",
    "80.3654",
    "Evergreen",
    LINE2,
    "Orlando",
    STREET,
)
NO_ROUTE = {"route": None}
ROUTE_UNAVAILABLE = {
    "error": {
        "code": "route_unavailable",
        "message": "The route is unavailable right now. Try again later.",
    }
}
DISTANCE_M, DURATION_S = 15234.6, 1260.4


def drive(points: int = 3, steps: int = 3) -> DrivingRoute:
    """A route of `points` points on the straight line from the pro to the address, and
    `steps` streets, the second one unnamed."""
    last = points - 1
    return DrivingRoute(
        geometry=tuple(
            Coordinate(
                lat=LAT + (DEST_LAT - LAT) * index / last,
                lng=LNG + (DEST_LNG - LNG) * index / last,
            )
            for index in range(points)
        ),
        distance_m=DISTANCE_M,
        duration_s=DURATION_S,
        steps=tuple(
            RouteStep(
                street_name="" if index == 1 else f"{STREET} {index}",
                distance_m=100.5 + index,
                duration_s=20.25 + index,
            )
            for index in range(steps)
        ),
    )


class FakeMapbox:
    """A RouteProvider that records what it is asked. `hold` keeps a route waiting; a route
    asked for while `failing` is set ends as Mapbox being unavailable."""

    def __init__(self) -> None:
        self.geocodes: list[StreetAddress] = []
        self.routes: list[tuple[Coordinate, Coordinate]] = []
        self.place: Coordinate | None = GEOCODED
        self.found: DrivingRoute | None = drive()
        self.hold: asyncio.Event | None = None
        self.failing = False
        self.entered = asyncio.Event()

    async def asked_for_a_route(self) -> None:
        """Waits until `route` is entered (again)."""
        async with asyncio.timeout(5):
            await self.entered.wait()
        self.entered.clear()

    @property
    def calls(self) -> int:
        return len(self.geocodes) + len(self.routes)

    async def geocode(self, address: StreetAddress) -> Coordinate | None:
        self.geocodes.append(address)
        return self.place

    async def route(self, origin: Coordinate, destination: Coordinate) -> DrivingRoute | None:
        self.routes.append((origin, destination))
        self.entered.set()
        failing = self.failing
        if self.hold is not None:
            await self.hold.wait()
        if failing:
            raise MapboxUnavailableError
        return self.found


@pytest.fixture(autouse=True)
def queue(app: FastAPI) -> RecordingQueue:
    """The job pushes (#65) are queued here, never on Redis."""
    return record_pushes(app)


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


@pytest.fixture
def mapbox(app: FastAPI) -> FakeMapbox:
    fake = FakeMapbox()
    app.dependency_overrides[get_route_provider] = lambda: fake
    return fake


@pytest.fixture
def cache(app: FastAPI, redis: Redis, prefix: str) -> RedisJobRouteCache:
    """In the same Redis and under the same prefix as `store`'s positions."""
    cache = RedisJobRouteCache(redis, None, timeout_seconds=STORE_TIMEOUT, prefix=prefix)
    app.dependency_overrides[get_job_route_cache] = lambda: cache
    return cache


def url(job_id: uuid.UUID) -> str:
    return f"/v1/jobs/{job_id}/route"


def position_url(job_id: uuid.UUID) -> str:
    return f"/v1/jobs/{job_id}/pro-location"


async def ask(client: httpx.AsyncClient, job_id: uuid.UUID, party: Party) -> httpx.Response:
    return await client.get(url(job_id), headers=party.headers)


async def shown(client: httpx.AsyncClient, job_id: uuid.UUID, world: JobWorld) -> Any:
    response = await ask(client, job_id, world.customer)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert set(response.json()) == {"route"}
    return response.json()["route"]


async def locate(session: AsyncSession, world: JobWorld) -> None:
    """Gives the job's address its coordinates: no geocoding is needed."""
    address = await session.get(Address, world.address_id)
    assert address is not None
    address.lat, address.lng = Decimal(str(DEST_LAT)), Decimal(str(DEST_LNG))
    await session.flush()


async def move(
    store: RedisJobLocationStore, job_id: uuid.UUID, at: datetime, north: float
) -> Coordinate:
    """The pro's next position, `north` degrees of latitude from the first one."""
    moved = position(at, lat=LAT + north)
    assert await store.put(job_id, moved, min_interval=timedelta(0), ttl_seconds=TTL)
    return Coordinate(lat=moved.lat, lng=moved.lng)


async def keys(redis: Redis, prefix: str) -> set[str]:
    return {key.decode() async for key in redis.scan_iter(match=f"{prefix}:*")}


def route_events(caplog: pytest.LogCaptureFixture) -> list[tuple[str, str, str | None]]:
    return [
        (r.levelname, r.getMessage(), getattr(r, "job_id", None))
        for r in caplog.records
        if r.name == ROUTE_LOGGER
    ]


# Criterion 1: the route, shaped and capped


async def test_route_shape_and_caps(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    clock: list[datetime],
) -> None:
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)
    mapbox.found = drive(points=2001, steps=45)

    with counted_statements(db_session) as statements:
        route = await shown(db_client, job.id, world)

    assert set(route) == {"geometry", "distance_m", "duration_s", "steps", "computed_at"}
    # The line, thinned to the 500 points of ROUTE_MAX_POINTS: [lng, lat] pairs, in order, the
    # pro's end and the address's end both kept.
    line = route["geometry"]
    assert len(line) == 500
    assert line[0] == [LNG, LAT]
    assert line[-1] == [DEST_LNG, DEST_LAT]
    assert all(len(point) == 2 for point in line)
    assert [point[1] for point in line] == sorted({point[1] for point in line})
    assert (route["distance_m"], route["duration_s"]) == (DISTANCE_M, DURATION_S)
    # The first 30 streets of ROUTE_MAX_STEPS: a name (null on an unnamed road) and two numbers.
    assert len(route["steps"]) == 30
    assert route["steps"][:3] == [
        {"street_name": f"{STREET} 0", "distance_m": 100.5, "duration_s": 20.25},
        {"street_name": None, "distance_m": 101.5, "duration_s": 21.25},
        {"street_name": f"{STREET} 2", "distance_m": 102.5, "duration_s": 22.25},
    ]
    assert route["steps"][-1]["street_name"] == f"{STREET} 29"
    assert route["computed_at"] == "2026-11-10T15:00:00Z"
    # From the pro's position to the address's own coordinates: one call, no geocoding.
    assert mapbox.routes == [(ORIGIN, DESTINATION)]
    assert mapbox.geocodes == []
    # The database is read, never written.
    assert statements
    assert all(s.lstrip().upper().startswith("SELECT") for s in statements), statements


async def test_short_route_is_answered_whole(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
) -> None:
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)

    route = await shown(db_client, job.id, world)

    assert route["geometry"] == [
        [LNG, LAT],
        [(LNG + DEST_LNG) / 2, (LAT + DEST_LAT) / 2],
        [DEST_LNG, DEST_LAT],
    ]
    assert len(route["steps"]) == 3


@pytest.mark.parametrize("settings", [{"route_max_points": 7, "route_max_steps": 2}], indirect=True)
async def test_caps_come_from_settings(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
) -> None:
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)
    mapbox.found = drive(points=100, steps=10)

    route = await shown(db_client, job.id, world)

    assert len(route["geometry"]) == 7
    assert (route["geometry"][0], route["geometry"][-1]) == ([LNG, LAT], [DEST_LNG, DEST_LAT])
    assert [step["street_name"] for step in route["steps"]] == [f"{STREET} 0", None]


def test_thinned_keeps_the_ends_and_spreads_evenly() -> None:
    assert thinned(list(range(10)), 4) == [0, 3, 6, 9]
    assert thinned(list(range(1001)), 2) == [0, 1000]
    assert thinned(list(range(501)), 500)[:2] == [0, 1]
    assert len(set(thinned(list(range(501)), 500))) == 500  # no point twice
    assert thinned([1, 2, 3], 3) == [1, 2, 3]
    assert thinned([1, 2, 3], 500) == [1, 2, 3]


def test_meters_between() -> None:
    assert meters_between(ORIGIN, ORIGIN) == 0
    assert 59 < meters_between(ORIGIN, Coordinate(lat=LAT + NORTH_60_M, lng=LNG)) < 61
    assert 119 < meters_between(ORIGIN, Coordinate(lat=LAT + NORTH_120_M, lng=LNG)) < 121
    # A degree of longitude is shorter away from the equator.
    assert 99_000 < meters_between(ORIGIN, Coordinate(lat=LAT, lng=LNG + 1)) < 100_500
    assert 111_000 < meters_between(Coordinate(0, 0), Coordinate(1, 0)) < 111_400


# Criterion 2: the cache


async def test_route_cache_and_100m_refresh(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    clock: list[datetime],
    redis: Redis,
    settings: Settings,
) -> None:
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)

    first = await shown(db_client, job.id, world)
    # Kept for ROUTE_CACHE_SECONDS (PTTL: milliseconds, not rounded): not shorter, not longer.
    left = await redis.pttl(cache.key(job.id)) / 1000
    assert settings.route_cache_seconds == 30
    assert settings.route_cache_seconds - 5 <= left <= settings.route_cache_seconds, left

    # 60 m on, a few seconds later: the same route, and Mapbox is not asked.
    clock[0] = NOW + timedelta(seconds=5)
    await move(store, job.id, clock[0], NORTH_60_M)
    for _ in range(10):
        assert await shown(db_client, job.id, world) == first
    assert len(mapbox.routes) == 1

    # 120 m from where that route starts (60 m from the last position): a new call, from here.
    clock[0] = NOW + timedelta(seconds=10)
    here = await move(store, job.id, clock[0], NORTH_120_M)
    second = await shown(db_client, job.id, world)
    assert mapbox.routes == [(ORIGIN, DESTINATION), (here, DESTINATION)]
    assert (first["computed_at"], second["computed_at"]) == (
        "2026-11-10T15:00:00Z",
        "2026-11-10T15:00:10Z",
    )

    # Back within 100 m of the new start: no call.
    clock[0] = NOW + timedelta(seconds=15)
    await move(store, job.id, clock[0], NORTH_60_M)
    assert await shown(db_client, job.id, world) == second
    assert len(mapbox.routes) == 2

    # An expiry time already past: Redis drops the route at once, and the next poll asks.
    assert await redis.pexpireat(cache.key(job.id), 1)
    await shown(db_client, job.id, world)
    assert len(mapbox.routes) == 3
    assert mapbox.geocodes == []


@pytest.mark.parametrize(
    "settings",
    [{"route_cache_seconds": 45, "route_refresh_distance_m": 500}],
    indirect=True,
)
async def test_cache_window_and_distance_come_from_settings(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    clock: list[datetime],
    redis: Redis,
) -> None:
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)

    await shown(db_client, job.id, world)
    left = await redis.pttl(cache.key(job.id)) / 1000
    clock[0] = NOW + timedelta(seconds=10)
    await move(store, job.id, clock[0], NORTH_120_M)
    await shown(db_client, job.id, world)

    assert 40 <= left <= 45, left  # not the default's 30
    assert len(mapbox.routes) == 1  # 120 m is within 500 m


async def test_one_request_at_a_time_asks_mapbox(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    clock: list[datetime],
    redis: Redis,
    settings: Settings,
) -> None:
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)

    # The first poll waits on Mapbox; polls arriving meanwhile get "no route yet" and ask
    # nobody.
    mapbox.hold = asyncio.Event()
    waiting = asyncio.create_task(ask(db_client, job.id, world.customer))
    await mapbox.asked_for_a_route()
    async with asyncio.timeout(5):  # a poll that asked Mapbox too would wait for good
        meanwhile = [await shown(db_client, job.id, world) for _ in range(3)]
    # The turn is held for every step made in it (the defaults: 2 x 5 s and 4 x 0.5 s, + 1)
    # under its request's token, which names no position.
    assert (settings.mapbox_timeout_seconds, settings.pro_location_timeout_seconds) == (5.0, 0.5)
    assert 8 <= await redis.ttl(cache.claim_key(job.id)) <= 13
    holder = await redis.get(cache.claim_key(job.id))
    assert holder is not None
    assert re.fullmatch(rb"[0-9a-f]{32}", holder)
    mapbox.hold.set()
    first = (await waiting).json()["route"]

    assert meanwhile == [None, None, None]
    assert first is not None
    assert len(mapbox.routes) == 1
    assert await redis.exists(cache.claim_key(job.id)) == 0  # the turn was given back

    # The pro moved on: while the new route is on its way, the one being replaced is answered.
    clock[0] = NOW + timedelta(seconds=10)
    await move(store, job.id, clock[0], NORTH_120_M)
    mapbox.hold = asyncio.Event()
    waiting = asyncio.create_task(ask(db_client, job.id, world.customer))
    await mapbox.asked_for_a_route()
    async with asyncio.timeout(5):
        meanwhile = [await shown(db_client, job.id, world) for _ in range(3)]
    mapbox.hold.set()
    second = (await waiting).json()["route"]

    assert meanwhile == [first, first, first]
    assert second["computed_at"] == "2026-11-10T15:00:10Z"
    assert len(mapbox.routes) == 2
    assert await redis.exists(cache.claim_key(job.id)) == 0


# The second look at the cache, with the turn held (#383 round 1)


class HeldAtTheAddress:
    """Holds the next `polls` route requests where they read the job's address: each has looked
    at the cache and found nothing to answer with, and has not asked for the job's turn yet.
    `arrived[n]` says the nth is there and `go[n]` lets it on: no sleep, no expiry."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, polls: int = 1) -> None:
        self.arrived = [asyncio.Event() for _ in range(polls)]
        self.go = [asyncio.Event() for _ in range(polls)]
        read = CustomerRequestReader.place
        seen = 0

        async def place(reader: CustomerRequestReader, request_id: uuid.UUID) -> AddressPlace:
            nonlocal seen
            index, seen = seen, seen + 1
            if index < polls:
                self.arrived[index].set()
                await self.go[index].wait()
            return await read(reader, request_id)

        monkeypatch.setattr(CustomerRequestReader, "place", place)

    async def reached_by(self, index: int = 0) -> None:
        async with asyncio.timeout(5):
            await self.arrived[index].wait()

    def open(self) -> None:
        for go in self.go:
            go.set()


async def ended(*polls: "asyncio.Task[httpx.Response] | None") -> None:
    """Leaves no held poll behind a failed test."""
    tasks = [poll for poll in polls if poll is not None]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.parametrize(
    "stored_coordinates", [True, False], ids=["stored_coordinates", "geocoded"]
)
async def test_overlapping_polls_ask_mapbox_once(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    redis: Redis,
    monkeypatch: pytest.MonkeyPatch,
    stored_coordinates: bool,
) -> None:
    """The Gatekeeper's interleaving: a poll finds no route in the cache and is still reading
    the address when another finds none either, takes the turn, asks Mapbox, keeps the route
    and gives the turn back. The first poll then gets the free turn. The pro has not moved and
    the kept route is good: it is the answer, and Mapbox is asked nothing more."""
    job = await on_the_way_job(db_session, world)
    if stored_coordinates:
        await locate(db_session, world)
    await plant(store, job.id)
    held = HeldAtTheAddress(monkeypatch)
    early = asyncio.create_task(ask(db_client, job.id, world.customer))
    try:
        await held.reached_by()
        async with asyncio.timeout(5):
            route = await shown(db_client, job.id, world)
        assert route is not None
        assert await cache.get(job.id) is not None
        geocodes, routes = list(mapbox.geocodes), list(mapbox.routes)
        assert (len(geocodes), len(routes)) == (0 if stored_coordinates else 1, 1)
        held.open()
        async with asyncio.timeout(5):
            answer = await early
    finally:
        held.open()
        await ended(early)

    assert (answer.status_code, answer.json()) == (200, {"route": route})
    assert answer.headers["cache-control"] == "no-store"
    assert (mapbox.geocodes, mapbox.routes) == (geocodes, routes)  # nothing asked twice
    assert await redis.exists(cache.claim_key(job.id)) == 0  # the turn was given back


async def test_route_kept_meanwhile_from_elsewhere_does_not_answer(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    clock: list[datetime],
    redis: Redis,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The second look decides as the first does: a route kept meanwhile is the answer only
    while the pro is within the refresh distance of where it starts."""
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)
    held = HeldAtTheAddress(monkeypatch, polls=2)
    # One poll saw the pro at the first position and the other 120 m on; neither found a route.
    early = asyncio.create_task(ask(db_client, job.id, world.customer))
    late: asyncio.Task[httpx.Response] | None = None
    try:
        await held.reached_by(0)
        clock[0] = NOW + timedelta(seconds=5)
        here = await move(store, job.id, clock[0], NORTH_120_M)
        late = asyncio.create_task(ask(db_client, job.id, world.customer))
        await held.reached_by(1)
        async with asyncio.timeout(5):
            held.go[0].set()
            first = (await early).json()["route"]
            between = await cache.get(job.id)
            held.go[1].set()
            second = (await late).json()["route"]
    finally:
        held.open()
        await ended(early, late)

    # The route kept from the first position starts 120 m from the second poll's pro: that
    # poll asks Mapbox from where it saw the pro, and its route is the one kept now.
    assert between is not None
    assert between.origin == ORIGIN
    assert mapbox.routes == [(ORIGIN, DESTINATION), (here, DESTINATION)]
    assert (first["computed_at"], second["computed_at"]) == (
        "2026-11-10T15:00:05Z",
        "2026-11-10T15:00:05Z",
    )
    kept = await cache.get(job.id)
    assert kept is not None
    assert kept.origin == here
    assert await redis.exists(cache.claim_key(job.id)) == 0


class GoneAtTheSecondLook(RedisJobRouteCache):
    """Answers a poll's first `get` from Redis and fails its second, the one it makes with the
    job's turn held, as the cache going away or being refused between the two would."""

    error: Exception = RedisConnectionError("probe: gone")
    looks = 0

    async def get(self, job_id: uuid.UUID) -> CachedRoute | None:
        self.looks += 1
        if self.looks == 2:
            raise self.error
        return await super().get(job_id)


@pytest.mark.parametrize(
    ("error", "answer", "event"),
    [
        (RedisConnectionError("probe: gone"), ROUTE_UNAVAILABLE, "job_route_cache_unavailable"),
        (TimeoutError(), ROUTE_UNAVAILABLE, "job_route_cache_unavailable"),
        (
            LocationStoreRefusedError("not_ephemeral"),
            LOCATION_UNAVAILABLE,
            "job_route_store_refused",
        ),
    ],
    ids=["gone", "slow", "refused"],
)
async def test_cache_lost_with_the_turn_held_asks_nobody_and_gives_the_turn_back(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    mapbox: FakeMapbox,
    redis: Redis,
    prefix: str,
    caplog: pytest.LogCaptureFixture,
    error: Exception,
    answer: dict[str, Any],
    event: str,
) -> None:
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)
    flaky = GoneAtTheSecondLook(redis, None, timeout_seconds=STORE_TIMEOUT, prefix=prefix)
    flaky.error = error
    app.dependency_overrides[get_job_route_cache] = lambda: flaky

    with caplog.at_level(logging.DEBUG):
        response = await ask(db_client, job.id, world.customer)

    # As when the first look fails: the cache's answer, and no call to Mapbox.
    assert (response.status_code, response.json()) == (503, answer)
    assert mapbox.calls == 0
    assert route_events(caplog) == [("ERROR", event, str(job.id))]
    assert not any(r.exc_info for r in caplog.records)
    # The turn went back to anybody: Mapbox did not fail, so nobody is held off. The next poll
    # (the cache answers it) asks Mapbox and gets its route.
    assert await redis.exists(flaky.claim_key(job.id)) == 0
    assert await shown(db_client, job.id, world) is not None
    assert len(mapbox.routes) == 1


# How long a turn lasts and who may end it (#383 round 2)


class StepsOfATurn(InMemoryJobRouteCache):
    """Lists what a request asks of the cache from the claim that gives it a job's turn to the
    end of that turn."""

    def __init__(self) -> None:
        super().__init__()
        self.steps: list[str] = []
        self._held = False

    def _step(self, name: str) -> None:
        if self._held:
            self.steps.append(name)

    async def claim(self, job_id: uuid.UUID, *, token: str, seconds: int) -> Turn:
        turn = await super().claim(job_id, token=token, seconds=seconds)
        self._held = turn == "mine"
        self._step("claim")
        return turn

    async def get(self, job_id: uuid.UUID) -> CachedRoute | None:
        self._step("get")
        return await super().get(job_id)

    async def put(self, job_id: uuid.UUID, entry: CachedRoute, *, ttl_seconds: int) -> bool:
        self._step("put")
        return await super().put(job_id, entry, ttl_seconds=ttl_seconds)

    async def release(self, job_id: uuid.UUID, *, token: str) -> None:
        self._step("release")
        self._held = False
        await super().release(job_id, token=token)


@pytest.mark.parametrize(
    ("settings", "seconds"),
    [
        # 2 x Mapbox's deadline and 4 x the cache's, rounded up, and one second.
        ({"mapbox_timeout_seconds": 5.0, "pro_location_timeout_seconds": 0.5}, 13),  # defaults
        ({"mapbox_timeout_seconds": 2.0, "pro_location_timeout_seconds": 1.5}, 11),
        ({"mapbox_timeout_seconds": 0.1, "pro_location_timeout_seconds": 4.0}, 18),
        ({"mapbox_timeout_seconds": 0.25, "pro_location_timeout_seconds": 0.3}, 3),
        ({"mapbox_timeout_seconds": 3.0, "pro_location_timeout_seconds": 2.5}, 17),
    ],
    indirect=["settings"],
)
async def test_turn_lasts_for_all_that_is_done_in_it(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    mapbox: FakeMapbox,
    settings: Settings,
    seconds: int,
) -> None:
    """Redis counts a turn's time from the moment it takes the claim, so the turn outlasts
    every step its request makes from there, each as slow as its deadline lets it be: the
    claim's own answer, the second look at the cache, both Mapbox calls, the write of the
    route and the end of the turn. One that ended sooner would let a second request ask Mapbox
    meanwhile."""
    config = JobRouteConfig.from_settings(settings)
    assert config.claim_seconds == seconds

    # The steps are counted on a turn as it is made, one that needs both of Mapbox's calls.
    job = await on_the_way_job(db_session, world)  # no lat/lng: geocoded, then routed
    await plant(store, job.id)
    turn = StepsOfATurn()
    app.dependency_overrides[get_job_route_cache] = lambda: turn
    assert await shown(db_client, job.id, world) is not None

    assert turn.steps == ["claim", "get", "put", "release"]
    assert (len(mapbox.geocodes), len(mapbox.routes)) == (1, 1)
    slowest = (
        len(turn.steps) * settings.pro_location_timeout_seconds
        + mapbox.calls * settings.mapbox_timeout_seconds
    )
    assert slowest + 1 <= config.claim_seconds < slowest + 2


async def test_turn_to_ask_ends_by_itself(redis: Redis, prefix: str) -> None:
    """A request that died holding a job's turn does not hold it for good, and neither does
    the wait after a failure."""
    cache = RedisJobRouteCache(redis, None, timeout_seconds=STORE_TIMEOUT, prefix=prefix)
    job_id = uuid.uuid4()

    assert await cache.claim(job_id, token="first", seconds=11) == "mine"
    assert await cache.claim(job_id, token="second", seconds=11) == "taken"
    assert 6 <= await redis.ttl(cache.claim_key(job_id)) <= 11
    await cache.release(job_id, token="first")
    assert await cache.claim(job_id, token="third", seconds=11) == "mine"
    # After a failure: nobody's turn for the seconds given, then anybody's again.
    await cache.hold_off(job_id, token="third", seconds=7)
    assert await cache.claim(job_id, token="fourth", seconds=11) == "held_off"
    assert 2 <= await redis.ttl(cache.claim_key(job_id)) <= 7  # the claim did not extend it
    assert await redis.get(cache.claim_key(job_id)) == b"held-off"  # no position in it
    assert await redis.pexpireat(cache.claim_key(job_id), 1)
    assert await cache.claim(job_id, token="fifth", seconds=11) == "mine"


async def test_turn_is_ended_by_its_own_request_only(redis: Redis, prefix: str) -> None:
    """A request that outlived its turn finds it another request's when it is done. Whatever
    it does then, give the turn back or hold the job off after Mapbox failed, leaves that turn
    with the request that has it, for the time it has left."""
    cache = RedisJobRouteCache(redis, None, timeout_seconds=STORE_TIMEOUT, prefix=prefix)
    job_id = uuid.uuid4()
    key = cache.claim_key(job_id)

    assert await cache.claim(job_id, token="old", seconds=30) == "mine"
    assert await redis.pexpireat(key, 1)  # the old request's turn ran out
    assert await cache.claim(job_id, token="next", seconds=30) == "mine"

    await cache.release(job_id, token="old")
    assert await redis.get(key) == b"next"
    await cache.hold_off(job_id, token="old", seconds=7)
    assert await redis.get(key) == b"next"
    assert 25 <= await redis.ttl(key) <= 30  # not the wait's 7
    assert await cache.claim(job_id, token="third", seconds=30) == "taken"

    # The request whose turn it is ends it.
    await cache.release(job_id, token="next")
    assert await redis.exists(key) == 0


async def test_wait_after_a_failure_is_nobodys_to_end(redis: Redis, prefix: str) -> None:
    """The wait after Mapbox failed starts whether the failed request's turn was still its own
    or had run out with nobody after it, and no request done meanwhile ends or renews it."""
    cache = RedisJobRouteCache(redis, None, timeout_seconds=STORE_TIMEOUT, prefix=prefix)
    job_id = uuid.uuid4()
    key = cache.claim_key(job_id)

    assert await cache.claim(job_id, token="failed", seconds=30) == "mine"
    await cache.hold_off(job_id, token="failed", seconds=7)
    assert await redis.get(key) == b"held-off"
    # An older request done now, well or not: the wait is as it was.
    await cache.release(job_id, token="old")
    await cache.hold_off(job_id, token="old", seconds=30)
    assert await redis.get(key) == b"held-off"
    assert 2 <= await redis.ttl(key) <= 7
    assert await cache.claim(job_id, token="next", seconds=30) == "held_off"

    # A turn that ran out and that nobody took since: its failure still holds the job off.
    assert await redis.pexpireat(key, 1)
    assert await cache.claim(job_id, token="slow", seconds=30) == "mine"
    assert await redis.pexpireat(key, 1)
    await cache.hold_off(job_id, token="slow", seconds=7)
    assert await redis.get(key) == b"held-off"
    assert 2 <= await redis.ttl(key) <= 7


@pytest.mark.parametrize("fails", [False, True], ids=["answered", "mapbox_failed"])
async def test_request_that_outlived_its_turn_leaves_the_next_requests(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    redis: Redis,
    fails: bool,
) -> None:
    """A request is still waiting for Mapbox when its turn runs out: the next request takes
    the turn and asks too. When the first is done at last, with its route or with Mapbox's
    failure, the turn is the second's still: it is neither given away (a third request would
    ask Mapbox as well) nor made the wait after a failure."""
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)
    key = cache.claim_key(job.id)
    first_hold, second_hold = asyncio.Event(), asyncio.Event()
    mapbox.hold, mapbox.failing = first_hold, fails
    old = asyncio.create_task(ask(db_client, job.id, world.customer))
    following: asyncio.Task[httpx.Response] | None = None
    try:
        await mapbox.asked_for_a_route()
        olds = await redis.get(key)
        assert await redis.pexpireat(key, 1)  # the first request's turn ran out
        mapbox.hold, mapbox.failing = second_hold, False
        following = asyncio.create_task(ask(db_client, job.id, world.customer))
        await mapbox.asked_for_a_route()
        theirs = await redis.get(key)
        assert theirs is not None
        assert theirs != olds  # each request's turn has its own token

        async with asyncio.timeout(5):
            first_hold.set()
            first = await old
            assert first.status_code == (503 if fails else 200)
            # The turn is the second request's still, and a poll now asks nobody: it gets the
            # route the first one kept, or "no route yet" when Mapbox failed it.
            assert await redis.get(key) == theirs
            meanwhile = await ask(db_client, job.id, world.customer)
            assert meanwhile.status_code == 200
            assert meanwhile.json() == (NO_ROUTE if fails else first.json())
            assert len(mapbox.routes) == 2
            second_hold.set()
            second = await following
    finally:
        first_hold.set()
        second_hold.set()
        await ended(old, following)

    assert second.status_code == 200
    assert second.json()["route"] is not None
    assert len(mapbox.routes) == 2  # the first request's, and the one its lost turn cost
    assert await redis.exists(key) == 0  # ended by the request whose turn it was


class SlowAnswers(RedisJobRouteCache):
    """Redis does at once what the first request with a job's turn asks of it, and its answers
    are slow to arrive: the claim's takes CLAIM_ANSWER_S, the second look SECOND_LOOK_S, and the
    write of the route starts (`writing`) and waits for the test (`write`)."""

    CLAIM_ANSWER_S = 3.5
    SECOND_LOOK_S = 3.5

    def __init__(self, redis: Redis, *, timeout_seconds: float, prefix: str) -> None:
        super().__init__(redis, None, timeout_seconds=timeout_seconds, prefix=prefix)
        self.claims = self.looks = self.writes = 0
        self.writing = asyncio.Event()
        self.write = asyncio.Event()

    async def claim(self, job_id: uuid.UUID, *, token: str, seconds: int) -> Turn:
        turn = await super().claim(job_id, token=token, seconds=seconds)
        self.claims += 1
        if self.claims == 1:
            # Redis has the claim and counts its time; the answer is on its way.
            await asyncio.sleep(self.CLAIM_ANSWER_S)
        return turn

    async def get(self, job_id: uuid.UUID) -> CachedRoute | None:
        self.looks += 1
        if self.looks == 2:
            await asyncio.sleep(self.SECOND_LOOK_S)
        return await super().get(job_id)

    async def put(self, job_id: uuid.UUID, entry: CachedRoute, *, ttl_seconds: int) -> bool:
        self.writes += 1
        if self.writes == 1:
            self.writing.set()
            await self.write.wait()
        return await super().put(job_id, entry, ttl_seconds=ttl_seconds)


WRITE_S = 3.1


@pytest.mark.parametrize(
    "settings",
    [{"mapbox_timeout_seconds": 0.1, "pro_location_timeout_seconds": 4.0}],
    indirect=True,
)
async def test_turn_outlasts_slow_answers_from_the_cache(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    mapbox: FakeMapbox,
    redis: Redis,
    prefix: str,
    settings: Settings,
) -> None:
    """The Gatekeeper's probe of the turn's time (#383 round 2), in real time against Redis.
    Redis takes the first poll's claim at once and its answer is 3.5 s on its way; the second
    look takes 3.5 s and the write of the route 3.1 s: each within the cache's 4 s deadline,
    10.1 s in all. A turn of ceil(2 x 0.1 + 2 x 4) + 1 = 10 s had run out by then: a second
    poll took it and asked Mapbox too, and the first poll's end of turn deleted the second's
    claim. Nothing here moves Redis's clock or the claim's expiry, so this takes ten seconds."""
    slowest = max(SlowAnswers.CLAIM_ANSWER_S, SlowAnswers.SECOND_LOOK_S, WRITE_S)
    assert slowest < settings.pro_location_timeout_seconds
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)
    slow = SlowAnswers(redis, timeout_seconds=settings.pro_location_timeout_seconds, prefix=prefix)
    app.dependency_overrides[get_job_route_cache] = lambda: slow
    key = slow.claim_key(job.id)
    first = asyncio.create_task(ask(db_client, job.id, world.customer))
    try:
        async with asyncio.timeout(30):
            await slow.writing.wait()
            assert len(mapbox.routes) == 1
            await asyncio.sleep(WRITE_S)
            # The write is still on its way and the turn is the first poll's still: a poll
            # now finds it taken, gets "no route yet" and asks Mapbox nothing.
            holder = await redis.get(key)
            assert holder is not None
            assert await shown(db_client, job.id, world) is None
            assert len(mapbox.routes) == 1
            assert await redis.get(key) == holder
            slow.write.set()
            answer = await first
    finally:
        slow.write.set()
        await ended(first)

    assert answer.status_code == 200
    assert answer.json()["route"] is not None
    assert len(mapbox.routes) == 1
    assert await redis.exists(key) == 0  # given back by the poll whose turn it was


# The cached route follows the position: same Redis, never longer, deleted with it


async def test_cached_route_lives_and_ends_with_the_position(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    redis: Redis,
    prefix: str,
) -> None:
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)

    assert await shown(db_client, job.id, world) is not None
    # Next to the position, under the same prefix: these two keys and nothing else.
    assert await keys(redis, prefix) == {store.key(job.id), cache.key(job.id)}
    assert cache.key(job.id) == f"{prefix}:route:{job.id}"

    # The position has 10 s left: a route computed now is kept for no longer than that.
    await redis.delete(cache.key(job.id))
    assert await redis.pexpire(store.key(job.id), 10_000)
    assert await shown(db_client, job.id, world) is not None
    assert 0 < await redis.pttl(cache.key(job.id)) <= 10_000

    # The check-in ends the tracking: the position and the route go together.
    checked_in = await db_client.post(
        f"/v1/pros/me/jobs/{job.id}/check-in",
        json={"arrival_code": CODE, "lat": LAT, "lng": LNG},
        headers=world.pro.headers,
    )
    assert checked_in.status_code == 200, checked_in.text
    assert await keys(redis, prefix) == set()
    assert await shown(db_client, job.id, world) is None
    assert len(mapbox.routes) == 2


async def test_route_computed_while_tracking_ends_is_not_kept(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    redis: Redis,
    prefix: str,
) -> None:
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)
    mapbox.hold = asyncio.Event()

    waiting = asyncio.create_task(ask(db_client, job.id, world.customer))
    await mapbox.asked_for_a_route()
    await store.delete(job.id)  # what the check-in and every move out of on_the_way do
    mapbox.hold.set()
    response = await waiting

    # The poll already under way is answered; nothing of it stays behind.
    assert response.status_code == 200, response.text
    assert response.json()["route"] is not None
    assert await keys(redis, prefix) == set()


async def test_redis_cache_shows_only_what_it_wrote(
    redis: Redis, prefix: str, store: RedisJobLocationStore
) -> None:
    cache = RedisJobRouteCache(redis, None, timeout_seconds=STORE_TIMEOUT, prefix=prefix)
    job_id = uuid.uuid4()
    entry = CachedRoute(origin=ORIGIN, route=None)

    # No position: nothing is kept.
    assert await cache.put(job_id, entry, ttl_seconds=30) is False
    assert await cache.get(job_id) is None
    await plant(store, job_id)
    assert await cache.put(job_id, entry, ttl_seconds=30) is True
    assert await cache.get(job_id) == entry
    # A position that would never expire is not this code's: nothing is kept next to it.
    await redis.persist(store.key(job_id))
    await redis.delete(cache.key(job_id))
    assert await cache.put(job_id, entry, ttl_seconds=30) is False
    for foreign in (b"not json", b"[]", b'{"origin": [1], "route": null}', b'{"route": null}'):
        await redis.set(cache.key(job_id), foreign, ex=30)
        assert await cache.get(job_id) is None


# Criterion 3: no position, no route


async def test_no_position_returns_null_route(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    redis: Redis,
    prefix: str,
) -> None:
    job = await on_the_way_job(db_session, world)

    response = await ask(db_client, job.id, world.customer)

    assert (response.status_code, response.json()) == (200, NO_ROUTE)
    assert response.headers["cache-control"] == "no-store"
    assert mapbox.calls == 0
    assert await keys(redis, prefix) == set()


@pytest.mark.parametrize(
    ("status", "fields"),
    NOT_TRACKED,
    ids=[f"{s.value}{'-arrived' if f else ''}" for s, f in NOT_TRACKED],
)
async def test_not_on_the_way_is_null_route(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    redis: Redis,
    prefix: str,
    status: JobStatus,
    fields: dict[str, Any],
) -> None:
    job = await make_job(db_session, world, status, **fields)
    # A position left behind (a delete Redis missed) starts no route.
    await plant(store, job.id)

    response = await ask(db_client, job.id, world.customer)

    assert (response.status_code, response.json()) == (200, NO_ROUTE)
    assert mapbox.calls == 0
    assert await keys(redis, prefix) == {store.key(job.id)}


# Criterion 4: denials


async def test_denials_cost_the_same_and_make_no_vendor_call(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    redis: Redis,
    prefix: str,
) -> None:
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)
    job_id = job.id

    answers = {
        name: await ask(db_client, job_id, party)
        for name, party in [
            ("other_customer", world.other_customer),
            ("pro", world.pro),  # even the job's own pro: the customer's read only
            ("other_pro", world.other_pro),
            ("pro_without_profile", world.pro_without_profile),
            ("agent", world.agent),
            ("admin", world.admin),
        ]
    }
    anonymous = await db_client.get(url(job_id))
    missing = await ask(db_client, uuid.uuid4(), world.customer)

    assert {name: (r.status_code, r.json()) for name, r in answers.items()} == {
        "other_customer": (404, NOT_FOUND),
        "pro": (403, FORBIDDEN),
        "other_pro": (403, FORBIDDEN),
        "pro_without_profile": (403, FORBIDDEN),
        "agent": (403, FORBIDDEN),
        "admin": (403, FORBIDDEN),
    }
    assert anonymous.status_code == 401
    assert (missing.status_code, missing.json()) == (404, NOT_FOUND)
    for response in (*answers.values(), anonymous, missing):
        assert response.headers["cache-control"] == "no-store"
        assert not any(needle in response.text for needle in NEEDLES)

    # A foreign job and a missing one cost the same queries, the very ones of the position's
    # read (#350): the caller's account, the job.
    seen: dict[str, list[str]] = {}
    for name, target in [("foreign", job_id), ("missing", uuid.uuid4())]:
        # Every request starts with an empty session, as in production: no row comes from the
        # test's identity map without its query.
        db_session.expunge_all()
        with counted_statements(db_session) as statements:
            refused = await ask(db_client, target, world.other_customer)
        seen[f"route {name}"] = list(statements)
        db_session.expunge_all()
        with counted_statements(db_session) as statements:
            await db_client.get(position_url(target), headers=world.other_customer.headers)
        seen[f"position {name}"] = list(statements)
        assert (refused.status_code, refused.content) == (
            404,
            b'{"error":{"code":"not_found","message":"Resource not found."}}',
        )
    assert seen["route foreign"] == seen["route missing"], seen
    assert seen["route foreign"] == seen["position foreign"] == seen["position missing"], seen
    assert len(seen["route foreign"]) == 2, seen

    # Nobody was asked, and nothing was kept or claimed.
    assert mapbox.calls == 0
    assert await keys(redis, prefix) == {store.key(job_id)}


# Criterion 5: an address without coordinates


async def test_forward_geocode_fallback(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    clock: list[datetime],
    redis: Redis,
    prefix: str,
) -> None:
    job = await on_the_way_job(db_session, world)  # its address row has no lat/lng
    await plant(store, job.id)

    first = await shown(db_client, job.id, world)

    # Geocoded once, by its street line and place (never the unit line), then routed there.
    assert first is not None
    assert mapbox.geocodes == [
        StreetAddress(line1=LINE1, city="Orlando", state="FL", zip_code="32801")
    ]
    assert mapbox.routes == [(ORIGIN, GEOCODED)]
    # Polls inside the cache window ask for neither again.
    for _ in range(5):
        assert await shown(db_client, job.id, world) == first
    assert (len(mapbox.geocodes), len(mapbox.routes)) == (1, 1)

    # The geocoder's answer is kept nowhere: not on the address, and in Redis only as the
    # end of the cached route. A new route (the pro moved on) asks it again, once.
    address = await db_session.get(Address, world.address_id, populate_existing=True)
    assert address is not None
    assert (address.lat, address.lng) == (None, None)
    assert await keys(redis, prefix) == {store.key(job.id), cache.key(job.id)}
    clock[0] = NOW + timedelta(seconds=10)
    here = await move(store, job.id, clock[0], NORTH_120_M)
    await shown(db_client, job.id, world)
    assert len(mapbox.geocodes) == 2
    assert mapbox.routes == [(ORIGIN, GEOCODED), (here, GEOCODED)]


async def test_address_the_geocoder_cannot_place_is_null_route(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await on_the_way_job(db_session, world)
    await plant(store, job.id)
    mapbox.place = None  # Mapbox's "no such address"

    with caplog.at_level(logging.DEBUG):
        answers = [await ask(db_client, job.id, world.customer) for _ in range(4)]

    assert [(r.status_code, r.json()) for r in answers] == [(200, NO_ROUTE)] * 4
    # Asked once for the window, not once per poll; no route was asked for at all.
    assert (len(mapbox.geocodes), len(mapbox.routes)) == (1, 0)
    # A warning with the job's id, and nothing else.
    assert route_events(caplog) == [("WARNING", "job_route_no_destination", str(job.id))]
    [record] = [r for r in caplog.records if r.name == ROUTE_LOGGER]
    extras = set(vars(record)) - set(vars(logging.makeLogRecord({})))
    assert extras <= {"job_id", "request_id", "message", "asctime"}, extras


async def test_no_road_to_the_address_is_null_route(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)
    mapbox.found = None  # Mapbox's NoRoute / NoSegment

    with caplog.at_level(logging.DEBUG):
        answers = [await ask(db_client, job.id, world.customer) for _ in range(4)]

    assert [(r.status_code, r.json()) for r in answers] == [(200, NO_ROUTE)] * 4
    assert len(mapbox.routes) == 1
    assert route_events(caplog) == [("WARNING", "job_route_not_found", str(job.id))]


# Criterion 6: Mapbox fails


def _raise(error_type: type[httpx.TransportError]) -> Callable[[httpx.Request], httpx.Response]:
    def handler(request: httpx.Request) -> httpx.Response:
        raise error_type(f"boom {request.url}", request=request)

    return handler


def _status(status: int) -> Callable[[httpx.Request], httpx.Response]:
    return lambda _: httpx.Response(status, json={"message": VENDOR_TEXT, "code": STREET})


FAILURES: dict[str, Callable[[httpx.Request], httpx.Response]] = {
    "down": _raise(httpx.ConnectError),
    "timeout": _raise(httpx.ReadTimeout),
    "http_401": _status(401),
    "http_429": _status(429),
    "http_500": lambda _: httpx.Response(500, text=VENDOR_TEXT),
    "not_json": lambda _: httpx.Response(200, text=f"<html>{VENDOR_TEXT}"),
    "malformed": lambda _: httpx.Response(
        200, json={"code": "Ok", "routes": [{"message": VENDOR_TEXT}], "features": STREET}
    ),
}
GEOCODE_OK = httpx.Response(
    200,
    json={
        "type": "FeatureCollection",
        "features": [
            {
                "geometry": {"type": "Point", "coordinates": [GEO_LNG, GEO_LAT]},
                "properties": {"full_address": f"{LINE1}, Orlando"},
            }
        ],
    },
)
DIRECTIONS_OK = httpx.Response(
    200,
    json={
        "code": "Ok",
        "routes": [
            {
                "distance": DISTANCE_M,
                "duration": DURATION_S,
                "geometry": {"coordinates": [[LNG, LAT], [GEO_LNG, GEO_LAT]]},
                "legs": [{"steps": [{"name": STREET, "distance": 12.5, "duration": 3.5}]}],
            }
        ],
    },
)


class Mapbox:
    """The real client on a mock transport: `geocoding` and `directions` answer its two calls."""

    def __init__(self, app: FastAPI) -> None:
        self.geocoding: Callable[[httpx.Request], httpx.Response] = lambda _: GEOCODE_OK
        self.directions: Callable[[httpx.Request], httpx.Response] = lambda _: DIRECTIONS_OK
        self.requests: list[httpx.Request] = []
        client = MapboxRouteProvider(
            access_token=TOKEN, timeout_seconds=0.5, transport=httpx.MockTransport(self._answer)
        )
        app.dependency_overrides[get_route_provider] = lambda: client

    def _answer(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return (self.geocoding if request.method == "GET" else self.directions)(request)

    @property
    def asked(self) -> list[str]:
        return [request.method for request in self.requests]


@pytest.mark.parametrize("failure", list(FAILURES))
@pytest.mark.parametrize("failing", ["geocoding", "directions"])
async def test_vendor_failures_are_503_without_vendor_text(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    redis: Redis,
    prefix: str,
    settings: Settings,
    failure: str,
    failing: str,
) -> None:
    job = await on_the_way_job(db_session, world)  # no lat/lng: geocoded, then routed
    await plant(store, job.id)
    real = Mapbox(app)
    setattr(real, failing, FAILURES[failure])
    per_poll = ["GET"] if failing == "geocoding" else ["GET", "POST"]

    answers = [await ask(db_client, job.id, world.customer) for _ in range(4)]
    dot = await db_client.get(position_url(job.id), headers=world.customer.headers)

    for response in answers:
        assert (response.status_code, response.json()) == (503, ROUTE_UNAVAILABLE)
        assert response.headers["cache-control"] == "no-store"
        assert not any(needle in response.text for needle in NEEDLES)
    # Mapbox was asked by the first poll only: after a failure it is left alone for
    # ROUTE_RETRY_SECONDS, whatever the app does with its 503.
    assert real.asked == per_poll
    assert await keys(redis, prefix) == {store.key(job.id), cache.claim_key(job.id)}
    assert await redis.get(cache.claim_key(job.id)) == b"held-off"  # no position, no route
    left = await redis.ttl(cache.claim_key(job.id))
    assert settings.route_retry_seconds - 5 <= left <= settings.route_retry_seconds == 10, left
    # The wait over (an expiry time already past), the next poll asks again.
    assert await redis.pexpireat(cache.claim_key(job.id), 1)
    again = await ask(db_client, job.id, world.customer)
    assert (again.status_code, again.json()) == (503, ROUTE_UNAVAILABLE)
    assert real.asked == per_poll * 2
    # The app can still show the pro's dot.
    assert dot.status_code == 200, dot.text
    assert (dot.json()["position"]["lat"], dot.json()["position"]["lng"]) == (LAT, LNG)


@pytest.mark.parametrize("settings", [{"route_retry_seconds": 25}], indirect=True)
async def test_wait_after_a_failure_comes_from_settings_and_ends_with_a_route(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    redis: Redis,
    prefix: str,
) -> None:
    job = await on_the_way_job(db_session, world)
    await plant(store, job.id)
    real = Mapbox(app)
    real.directions = _status(429)

    assert (await ask(db_client, job.id, world.customer)).status_code == 503
    assert 20 <= await redis.ttl(cache.claim_key(job.id)) <= 25  # not the default's 10
    # Mapbox is back and the wait is over: the route, and no wait is left behind.
    real.directions = lambda _: DIRECTIONS_OK
    assert await redis.pexpireat(cache.claim_key(job.id), 1)
    assert await shown(db_client, job.id, world) is not None
    assert await keys(redis, prefix) == {store.key(job.id), cache.key(job.id)}


class Flaky(RedisJobRouteCache):
    """Reads and claims in Redis; fails where `failing` says, as Redis going away would."""

    failing: tuple[str, ...] = ()
    refused: bool = False

    async def put(self, job_id: uuid.UUID, entry: CachedRoute, *, ttl_seconds: int) -> bool:
        if self.refused:
            raise LocationStoreRefusedError("not_ephemeral")
        if "put" in self.failing:
            raise RedisConnectionError("probe: gone")
        return await super().put(job_id, entry, ttl_seconds=ttl_seconds)

    async def release(self, job_id: uuid.UUID, *, token: str) -> None:
        if "release" in self.failing:
            raise TimeoutError
        await super().release(job_id, token=token)


@pytest.mark.parametrize(
    ("failing", "refused", "logged"),
    [
        (("put",), False, ["job_route_computed", "job_route_cache_unavailable"]),
        (("release",), False, ["job_route_computed", "job_route_cache_unavailable"]),
        ((), True, ["job_route_computed", "job_route_store_refused"]),
    ],
    ids=["put_fails", "release_fails", "put_refused"],
)
async def test_route_that_cannot_be_kept_is_still_answered(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    mapbox: FakeMapbox,
    redis: Redis,
    prefix: str,
    caplog: pytest.LogCaptureFixture,
    failing: tuple[str, ...],
    refused: bool,
    logged: list[str],
) -> None:
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)
    flaky = Flaky(redis, None, timeout_seconds=STORE_TIMEOUT, prefix=prefix)
    flaky.failing, flaky.refused = failing, refused
    app.dependency_overrides[get_job_route_cache] = lambda: flaky

    with caplog.at_level(logging.DEBUG):
        route = await shown(db_client, job.id, world)

    # The route was paid for: it is answered, and what Redis refused is only logged.
    assert route is not None
    assert len(mapbox.routes) == 1
    assert [event for _, event, _ in route_events(caplog)] == logged
    assert not any(r.exc_info for r in caplog.records)
    kept = (await redis.exists(flaky.key(job.id))) == 1
    assert kept is (failing == ("release",))


# Criterion 8: no token


async def test_missing_token_is_503_route_unavailable(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    # No get_route_provider override and no MAPBOX_ACCESS_TOKEN: the app was built all the same.
    assert settings.mapbox_access_token is None
    assert get_route_provider not in app.dependency_overrides
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)

    with caplog.at_level(logging.DEBUG):
        response = await ask(db_client, job.id, world.customer)
        dot = await db_client.get(position_url(job.id), headers=world.customer.headers)

    assert (response.status_code, response.json()) == (503, ROUTE_UNAVAILABLE)
    assert dot.json()["position"] is not None
    # A known state of a deploy: a warning, so no Sentry event.
    assert [(r.levelname, r.getMessage()) for r in caplog.records if r.name == MAPBOX_LOGGER] == [
        ("WARNING", "mapbox_not_configured")
    ]


# Redis down, or one that must not hold positions: nobody is asked


async def test_cache_down_is_503_and_asks_nobody(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    mapbox: FakeMapbox,
    dead_redis: Redis,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)
    down = RedisJobRouteCache(dead_redis, None, timeout_seconds=0.3, prefix="jobloc-test-down")
    app.dependency_overrides[get_job_route_cache] = lambda: down

    with caplog.at_level(logging.DEBUG):
        response = await ask(db_client, job.id, world.customer)

    # Without the cache every poll would be a Mapbox call: none is made.
    assert (response.status_code, response.json()) == (503, ROUTE_UNAVAILABLE)
    assert mapbox.calls == 0
    assert route_events(caplog) == [("ERROR", "job_route_cache_unavailable", str(job.id))]
    assert not any(r.exc_info for r in caplog.records)  # no driver text


async def test_position_store_down_is_null_route_and_asks_nobody(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    dead_redis: Redis,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await on_the_way_job(db_session, world)
    down = RedisJobLocationStore(dead_redis, timeout_seconds=0.3, prefix="jobloc-test-down")
    app.dependency_overrides[get_job_location_store] = lambda: down

    with caplog.at_level(logging.DEBUG):
        response = await ask(db_client, job.id, world.customer)

    # As the position's own read answers "no position" then (#350).
    assert (response.status_code, response.json()) == (200, NO_ROUTE)
    assert mapbox.calls == 0
    assert route_events(caplog) == [("ERROR", "job_route_position_unavailable", str(job.id))]


async def test_refused_store_is_503_location_unavailable(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    mapbox: FakeMapbox,
    redis: Redis,
    prefix: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)
    answers: list[httpx.Response] = []

    with caplog.at_level(logging.DEBUG):
        # No Redis for positions at all (staging or production without LOCATION_REDIS_URL).
        app.dependency_overrides[get_job_location_store] = NoJobLocationStore
        answers.append(await ask(db_client, job.id, world.customer))
        # A position is readable, but the cache's Redis says it keeps what it is given.
        app.dependency_overrides[get_job_location_store] = lambda: store
        keeps = RedisJobRouteCache(
            redis, guard_on(ConfigOnly(SNAPSHOTS)), timeout_seconds=STORE_TIMEOUT, prefix=prefix
        )
        app.dependency_overrides[get_job_route_cache] = lambda: keeps
        answers.append(await ask(db_client, job.id, world.customer))

    assert [(r.status_code, r.json()) for r in answers] == [(503, LOCATION_UNAVAILABLE)] * 2
    assert mapbox.calls == 0
    assert await keys(redis, prefix) == {store.key(job.id)}  # no route went in
    assert [
        (r.levelname, r.getMessage(), r.__dict__["job_id"], r.__dict__["reason"])
        for r in caplog.records
        if r.name == ROUTE_LOGGER
    ] == [
        ("ERROR", "job_route_store_refused", str(job.id), "not_configured"),
        ("ERROR", "job_route_store_refused", str(job.id), "not_ephemeral"),
    ]


async def test_cache_dependency_uses_the_positions_redis(app: FastAPI) -> None:
    """The app's own dependency, as startup leaves it with LOCATION_REDIS_URL set: the cache
    goes to the positions' Redis, never the app's own (the queue's), and asks the same check
    of what that Redis keeps; without the positions' Redis there is no cache."""
    request = Request({"type": "http", "app": app})
    settings = make_settings(
        location_redis_url="redis://positions.invalid:6380/3", pro_location_timeout_seconds=0.7
    )
    shared = Redis.from_url("redis://queue.invalid:6379/0")
    backend = location_backend(settings, shared)
    assert isinstance(backend, LocationBackend)

    try:
        app.state.location_backend = backend
        cache = get_job_route_cache(request, settings)
        app.state.location_backend = None
        without = get_job_route_cache(request, settings)

        assert isinstance(cache, RedisJobRouteCache)
        assert cache._redis is backend.redis
        assert cache._redis is not shared
        assert cache._redis.connection_pool.connection_kwargs["host"] == "positions.invalid"
        assert cache._guard is backend.guard
        assert cache._timeout == 0.7
        assert isinstance(without, NoJobRouteCache)
    finally:
        await backend.redis.aclose()
        await shared.aclose()


async def test_no_cache_keeps_and_gives_nothing() -> None:
    cache = NoJobRouteCache()
    job_id = uuid.uuid4()

    assert await cache.claim(job_id, token="any", seconds=5) == "taken"
    await cache.release(job_id, token="any")
    await cache.hold_off(job_id, token="any", seconds=5)
    for call in (cache.get(job_id), cache.put(job_id, CachedRoute(ORIGIN, None), ttl_seconds=5)):
        with pytest.raises(Exception, match="not_configured"):
            await call


# Criterion 7: no token, coordinate, address or vendor URL in logs, errors or Sentry


async def test_no_secret_or_coordinate_in_logs(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    redis: Redis,
    dead_redis: Redis,
    clock: list[datetime],
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await on_the_way_job(db_session, world)  # no lat/lng: both calls are made
    done = await make_job(db_session, world, JobStatus.COMPLETED)
    await plant(store, job.id)
    real = Mapbox(app)
    down = RedisJobRouteCache(dead_redis, None, timeout_seconds=0.3, prefix="jobloc-test-down")
    errors: list[httpx.Response] = []

    async def moved_on(seconds: int) -> None:
        clock[0] = NOW + timedelta(seconds=seconds)
        await move(store, job.id, clock[0], NORTH_120_M * seconds)

    async def waited() -> None:
        """The wait after a failure, before Mapbox is asked again for the job, is over."""
        assert await redis.delete(cache.claim_key(job.id)) == 1

    # LOG_LEVEL=DEBUG, as the app applies it: httpx would name each request's URL at INFO.
    with caplog.at_level(logging.DEBUG):
        assert await shown(db_client, job.id, world) is not None  # geocoded and routed
        assert await shown(db_client, job.id, world) is not None  # from the cache
        await moved_on(1)
        real.directions = _status(429)
        errors.append(await ask(db_client, job.id, world.customer))  # 503
        errors.append(await ask(db_client, job.id, world.customer))  # 503: Mapbox left alone
        await waited()
        real.directions = _raise(httpx.ReadTimeout)
        errors.append(await ask(db_client, job.id, world.customer))  # 503
        await waited()
        real.directions = FAILURES["malformed"]
        errors.append(await ask(db_client, job.id, world.customer))  # 503
        await waited()
        real.directions = lambda _: httpx.Response(200, json={"code": "NoRoute", "routes": []})
        errors.append(await ask(db_client, job.id, world.customer))  # no road
        await moved_on(2)
        real.geocoding = _status(401)
        errors.append(await ask(db_client, job.id, world.customer))  # 503
        await waited()
        real.geocoding = lambda _: httpx.Response(200, json={"features": []})
        errors.append(await ask(db_client, job.id, world.customer))  # no such address
        errors.append(await ask(db_client, done.id, world.customer))  # not on the way
        errors.append(await ask(db_client, job.id, world.other_customer))  # 404
        errors.append(await ask(db_client, job.id, world.pro))  # 403
        app.dependency_overrides[get_job_route_cache] = lambda: down
        errors.append(await ask(db_client, job.id, world.customer))  # 503

    assert [r.status_code for r in errors] == [
        503,
        503,
        503,
        503,
        200,
        503,
        200,
        200,
        404,
        403,
        503,
    ]
    assert (real.asked.count("GET"), real.asked.count("POST")) == (7, 5)
    logs = log_fields(caplog.records)
    assert {r.getMessage() for r in caplog.records if r.name == ROUTE_LOGGER} == {
        "job_route_computed",
        "job_route_not_found",
        "job_route_no_destination",
        "job_route_cache_unavailable",
    }
    assert {r.getMessage() for r in caplog.records if r.name == MAPBOX_LOGGER} == {
        "mapbox_failed",
        "mapbox_unreachable",
        "mapbox_unexpected_response",
    }
    assert not any(r.name.startswith(("httpx", "httpcore")) for r in caplog.records)
    for needle in NEEDLES:
        assert [field for field in logs if needle in field] == [], needle
        for response in errors:  # none of them carries a route
            assert needle not in response.text, needle
    assert not any(r.exc_info for r in caplog.records)
    # Ids, the event name, and what failed: nothing else.
    for record in caplog.records:
        if record.name in (ROUTE_LOGGER, MAPBOX_LOGGER):
            extras = set(vars(record)) - set(vars(logging.makeLogRecord({})))
            assert extras <= {
                "job_id",
                "geocoded",
                "api",
                "status_code",
                "error",
                "reason",
                "request_id",
                "message",
                "asctime",
            }, extras


class CrashesAfterAsking(MapboxRouteProvider):
    """Asks Mapbox for the route, then fails as an unexpected bug would."""

    async def route(self, origin: Coordinate, destination: Coordinate) -> DrivingRoute | None:
        await super().route(origin, destination)
        raise RuntimeError("after the call")


async def test_nothing_reaches_sentry(
    sentry_transport: MemoryTransport,
    db_session: AsyncSession,
    world: JobWorld,
    redis: Redis,
    prefix: str,
) -> None:
    """Sentry on, sending to memory. Mapbox refusing the route after it placed the address
    (the ERROR log is an event, with both calls among its breadcrumbs), and an unexpected
    error after a route came back (its event carries the request, the Redis calls and both
    Mapbox calls): no token, position, address, street or vendor URL in either."""
    app = make_app(make_settings(sentry_dsn=TEST_DSN))
    record_pushes(app)
    app.dependency_overrides[get_location_clock] = lambda: lambda: NOW
    app.state.rolled_back_session = db_session
    app.dependency_overrides[get_session] = _rolled_back_session
    store = RedisJobLocationStore(redis, timeout_seconds=STORE_TIMEOUT, prefix=prefix)
    cache = RedisJobRouteCache(redis, None, timeout_seconds=STORE_TIMEOUT, prefix=prefix)
    app.dependency_overrides[get_job_location_store] = lambda: store
    app.dependency_overrides[get_job_route_cache] = lambda: cache
    job = await on_the_way_job(db_session, world)  # no lat/lng: geocoded first
    await plant(store, job.id)
    real = Mapbox(app)
    crashing = CrashesAfterAsking(
        access_token=TOKEN, timeout_seconds=0.5, transport=httpx.MockTransport(real._answer)
    )

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        real.directions = _status(429)
        refused = await ask(client, job.id, world.customer)
        assert await redis.delete(cache.claim_key(job.id)) == 1  # the wait is over
        real.directions = lambda _: DIRECTIONS_OK
        app.dependency_overrides[get_route_provider] = lambda: crashing
        crashed = await ask(client, job.id, world.customer)
    sentry_sdk.flush()

    assert (refused.status_code, refused.json()) == (503, ROUTE_UNAVAILABLE)
    assert crashed.status_code == 500, crashed.text
    assert crashed.headers["cache-control"] == "no-store"
    assert real.asked == ["GET", "POST", "GET", "POST"]
    payloads = _payloads(sentry_transport)
    events = [json.loads(payload) for payload in payloads]
    [failed] = [e for e in events if e.get("logentry", {}).get("message") == "mapbox_failed"]
    [crash] = [
        e
        for e in events
        if [value["type"] for value in e.get("exception", {}).get("values", [])] == ["RuntimeError"]
    ]
    assert str(job.id) in crash["request"]["url"]
    for event in (failed, crash):
        # Both calls to Mapbox left a breadcrumb: the method and the status, never a URL.
        calls = [c["data"] for c in event["breadcrumbs"]["values"] if c.get("type") == "http"]
        assert [(c["http.method"], c["url"]) for c in calls] == [
            ("GET", MAPBOX_URL_LABEL),
            ("POST", MAPBOX_URL_LABEL),
        ]
        assert all("http.query" not in c for c in calls)
    # The crash's event has the Redis calls too: the commands, their arguments filtered.
    assert any(c.get("category") == "redis" for c in crash["breadcrumbs"]["values"])
    # Field by field, the clocks left out: an event's time can read 12:00:26.1234 (#387).
    wire = [field for event in events for field in unclocked_fields(event)]
    for needle in NEEDLES:
        assert [field for field in wire if needle in field] == [], needle
        assert needle not in refused.text, needle
        assert needle not in crashed.text, needle


# Criterion 9: the contract


def test_openapi_documents_the_route(app: FastAPI) -> None:
    schema = app.openapi()
    path = schema["paths"]["/v1/jobs/{job_id}/route"]

    assert set(path) == {"get"}
    assert "never stored in the database" in path["get"]["summary"]
    assert set(path["get"]["responses"]) == {"200", "401", "403", "404", "422", "503"}
    unavailable = path["get"]["responses"]["503"]["description"]
    assert "route_unavailable" in unavailable
    assert "location_unavailable" in unavailable
    schemas = schema["components"]["schemas"]
    assert set(schemas["JobRouteOut"]["required"]) == {"route"}
    assert set(schemas["JobRoute"]["required"]) == {
        "geometry",
        "distance_m",
        "duration_s",
        "steps",
        "computed_at",
    }
    assert set(schemas["JobRouteStep"]["required"]) == {"street_name", "distance_m", "duration_s"}
    point = schemas["JobRoute"]["properties"]["geometry"]["items"]
    assert (point["minItems"], point["maxItems"]) == (2, 2)
