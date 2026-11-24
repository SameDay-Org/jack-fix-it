"""The live job view (#596): GET /v1/jobs/{job_id}/live, for the job's customer and its pro.

Mapbox is the route tests' fake; positions, routes and the trip's first distance live in the
real Redis of REDIS_URL under a prefix of the test's own, deleted afterwards. The server's
clock is fixed (`clock`), and a test moves it.
"""

import uuid
from datetime import timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.live import trip_progress
from app.modules.jobs.location import (
    NoJobLocationStore,
    RedisJobLocationStore,
    get_job_location_store,
)
from app.modules.jobs.models import JobStatus
from app.modules.jobs.route import RedisJobRouteCache
from app.modules.requests.service import CustomerRequestReader
from tests.job_world import (
    CUSTOMER_EMAIL,
    CUSTOMER_FIRST,
    CUSTOMER_LAST,
    CUSTOMER_PHONE,
    LINE1,
    PRO_EMAIL,
    PRO_PHONE,
    JobWorld,
    Party,
    build_world,
    make_job,
    record_pushes,
)
from tests.test_job_route_api import (
    DISTANCE_M,
    DURATION_S,
    NORTH_120_M,
    FakeMapbox,
    cache,
    drive,
    locate,
    mapbox,
    move,
)
from tests.test_pro_location_api import (
    CODE,
    FORBIDDEN,
    LAT,
    LNG,
    NOT_FOUND,
    NOW,
    clock,
    on_the_way_job,
    plant,
    prefix,
    redis,
    settings,
    store,
)
from tests.test_requests_api import RecordingQueue

# Fixtures, used by name.
__all__ = ["cache", "clock", "mapbox", "prefix", "redis", "settings", "store"]

KEYS = {"job_public_code", "stage", "eta_seconds", "distance_meters", "progress", "updated_at"}
NOT_LIVE = {"error": {"code": "job_not_live", "message": "The job is not under way."}}
# What must never reach a lock screen: names, contacts, the address, the arrival code, the
# pro's position.
NEEDLES = (
    CUSTOMER_EMAIL,
    CUSTOMER_FIRST,
    CUSTOMER_LAST,
    CUSTOMER_PHONE,
    PRO_EMAIL,
    PRO_PHONE,
    "María",
    "Pérez",
    LINE1,
    CODE,
    str(LAT)[:7],
    str(LNG)[:7],
)


@pytest.fixture(autouse=True)
def queue(app: FastAPI) -> RecordingQueue:
    """The job pushes (#65) are queued here, never on Redis."""
    return record_pushes(app)


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


def url(job_id: uuid.UUID) -> str:
    return f"/v1/jobs/{job_id}/live"


async def live(
    client: httpx.AsyncClient, job_id: uuid.UUID, party: Party, expected: int = 200
) -> Any:
    response = await client.get(url(job_id), headers=party.headers)
    assert response.status_code == expected, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


async def code_of(session: AsyncSession, request_id: uuid.UUID) -> str:
    return await CustomerRequestReader(session).public_code(request_id)


# Criterion 1: the customer and the assigned pro, nobody else


async def test_live_view_for_customer_and_assigned_pro_only(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)

    for_customer = await live(db_client, job.id, world.customer)
    for_pro = await live(db_client, job.id, world.pro)

    assert for_customer == for_pro
    assert set(for_customer) == KEYS
    assert for_customer["job_public_code"] == await code_of(db_session, job.request_id)
    # Another customer, another pro and an unknown id get the same 404: no job leaks.
    for party in (world.other_customer, world.other_pro, world.pro_without_profile):
        assert await live(db_client, job.id, party, 404) == NOT_FOUND
    assert await live(db_client, uuid.uuid4(), world.customer, 404) == NOT_FOUND
    # Staff have no jobs of their own: refused by role, whatever the id.
    for staff in (world.agent, world.admin):
        assert await live(db_client, job.id, staff, 403) == FORBIDDEN
    assert (await db_client.get(url(job.id))).status_code == 401


# Criterion 2: only a job under way


@pytest.mark.parametrize(
    "status",
    [
        JobStatus.SCHEDULED,
        JobStatus.CONFIRMED,
        JobStatus.PAID_OUT,
        JobStatus.DISPUTED,
        JobStatus.REFUNDED,
        JobStatus.CANCELLED,
    ],
)
async def test_live_view_409_when_not_ongoing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    status: JobStatus,
) -> None:
    job = await make_job(db_session, world, status)

    for party in (world.customer, world.pro):
        assert await live(db_client, job.id, party, 409) == NOT_LIVE
    # Not the job's parties: still the 404, the job's status never shows through.
    assert await live(db_client, job.id, world.other_customer, 404) == NOT_FOUND


async def test_each_stage_and_its_progress(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    clock: list[Any],
) -> None:
    on_the_way = await on_the_way_job(db_session, world)
    arrived = await on_the_way_job(db_session, world, checked_in_at=NOW)
    working = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    done = await make_job(db_session, world, JobStatus.COMPLETED)

    seen = {
        name: await live(db_client, job.id, world.customer)
        for name, job in (
            ("on_the_way", on_the_way),
            ("arrived", arrived),
            ("working", working),
            ("done", done),
        )
    }

    assert {name: (view["stage"], view["progress"]) for name, view in seen.items()} == {
        "on_the_way": ("on_the_way", 0.0),  # no position yet: the road left is unknown
        "arrived": ("arrived", 0.5),
        "working": ("working", 0.75),
        "done": ("done_waiting_confirm", 1.0),
    }
    for view in seen.values():
        assert (view["eta_seconds"], view["distance_meters"]) == (None, None)
        assert view["updated_at"] == "2026-11-10T15:00:00Z"
    assert mapbox.calls == 0  # only a job on the way with a position asks for a route


# Criterion 3: the ETA, from the route, fresh and never negative


async def test_eta_and_distance_from_the_route(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    clock: list[Any],
) -> None:
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)

    view = await live(db_client, job.id, world.pro)

    assert view["stage"] == "on_the_way"
    assert (view["eta_seconds"], view["distance_meters"]) == (round(DURATION_S), round(DISTANCE_M))
    # The first route of the trip is the measure: nothing driven yet.
    assert view["progress"] == 0.0
    assert await store.trip_distance(job.id) == DISTANCE_M
    assert mapbox.calls == 1
    # Ten seconds on, the same route (the cache): the ETA is ten seconds shorter.
    clock[0] = NOW + timedelta(seconds=10)
    again = await live(db_client, job.id, world.customer)
    assert again["eta_seconds"] == round(DURATION_S) - 10
    assert mapbox.calls == 1


@pytest.mark.parametrize("settings", [{"live_position_max_age_seconds": 90}], indirect=True)
async def test_eta_null_when_position_stale(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    clock: list[Any],
) -> None:
    """LIVE_POSITION_MAX_AGE_SECONDS (90 here, from the settings): a position that old still
    gives an ETA, one a second older gives none, and no route is asked for it."""
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)

    clock[0] = NOW + timedelta(seconds=90)
    at_the_limit = await live(db_client, job.id, world.customer)
    clock[0] = NOW + timedelta(seconds=91)
    too_old = await live(db_client, job.id, world.customer)

    assert at_the_limit["eta_seconds"] is not None
    assert (too_old["eta_seconds"], too_old["distance_meters"]) == (None, None)
    assert too_old["stage"] == "on_the_way"
    assert mapbox.calls == 1  # the stale read asked nothing of Mapbox


async def test_eta_never_negative(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    clock: list[Any],
) -> None:
    """A route that said 10 s, still the one kept 25 s later (the pro has not moved): 0."""
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)
    found = drive()
    mapbox.found = type(found)(
        geometry=found.geometry, distance_m=40.0, duration_s=10.0, steps=found.steps
    )
    assert (await live(db_client, job.id, world.customer))["eta_seconds"] == 10

    clock[0] = NOW + timedelta(seconds=25)
    view = await live(db_client, job.id, world.customer)

    assert view["eta_seconds"] == 0
    assert view["distance_meters"] == 40


async def test_progress_follows_the_road_left_of_the_trip(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    cache: RedisJobRouteCache,
    mapbox: FakeMapbox,
    clock: list[Any],
) -> None:
    """The first route of the trip is kept as the measure; a later, shorter one moves the
    progress to half the share driven."""
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    await plant(store, job.id)
    assert (await live(db_client, job.id, world.customer))["progress"] == 0.0

    found = drive()
    mapbox.found = type(found)(
        geometry=found.geometry,
        distance_m=DISTANCE_M / 4,
        duration_s=DURATION_S / 4,
        steps=found.steps,
    )
    clock[0] = NOW + timedelta(seconds=20)
    await move(store, job.id, clock[0], NORTH_120_M)  # past the refresh distance: a new route
    view = await live(db_client, job.id, world.customer)

    assert view["distance_meters"] == round(DISTANCE_M / 4)
    assert view["progress"] == 0.375  # 0.5 x three quarters of the road driven
    assert await store.trip_distance(job.id) == DISTANCE_M  # the first one stays the measure
    assert mapbox.calls == 2


def test_trip_progress_bounds() -> None:
    assert trip_progress(100.0, None) == 0.0
    assert trip_progress(100.0, 0.0) == 0.0
    assert trip_progress(0.0, 100.0) == 0.5
    assert trip_progress(150.0, 100.0) == 0.0  # a longer road than the first: not below 0
    assert trip_progress(50.0, 100.0) == 0.25


async def test_the_trip_distance_goes_with_the_position(
    store: RedisJobLocationStore, redis: Redis, prefix: str
) -> None:
    """Kept only while the position is there, once, in the position's own key: its expiry
    and its delete take both."""
    job_id = uuid.uuid4()
    await store.keep_trip_distance(job_id, 500.0)
    assert await store.trip_distance(job_id) is None  # no position: nothing kept
    assert [key async for key in redis.scan_iter(match=f"{prefix}:*")] == []

    await plant(store, job_id)
    await store.keep_trip_distance(job_id, 500.0)
    await store.keep_trip_distance(job_id, 200.0)
    assert await store.trip_distance(job_id) == 500.0
    ttl = await redis.ttl(store.key(job_id))
    assert 0 < ttl <= 120

    await store.delete(job_id)
    assert await store.trip_distance(job_id) is None


# What the view never carries


async def test_live_view_has_no_personal_data(
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

    for party in (world.customer, world.pro):
        response = await db_client.get(url(job.id), headers=party.headers)
        assert response.status_code == 200, response.text
        assert set(response.json()) == KEYS
        for needle in (*NEEDLES, str(job.customer_price_cents), str(job.pro_payout_cents)):
            assert needle not in response.text, needle


# When the store or the route cannot answer, the view still does


async def test_a_refused_store_gives_an_unknown_eta(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    mapbox: FakeMapbox,
    caplog: pytest.LogCaptureFixture,
) -> None:
    app.dependency_overrides[get_job_location_store] = NoJobLocationStore
    job = await on_the_way_job(db_session, world)

    view = await live(db_client, job.id, world.customer)

    assert (view["stage"], view["eta_seconds"], view["progress"]) == ("on_the_way", None, 0.0)
    assert "job_live_store_refused" in caplog.messages
    assert mapbox.calls == 0


async def test_mapbox_down_gives_an_unknown_eta(
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
    mapbox.failing = True

    view = await live(db_client, job.id, world.customer)

    assert (view["stage"], view["eta_seconds"], view["distance_meters"]) == (
        "on_the_way",
        None,
        None,
    )
