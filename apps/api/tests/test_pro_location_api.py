"""The pro's live position while on the way (#350): PUT (pro) and GET (customer)
/v1/jobs/{job_id}/pro-location.

Positions live in the real Redis of REDIS_URL under a prefix of the test's own, deleted
afterwards; the server's clock for positions is fixed (`clock`), and a test moves it.
"""

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
import sentry_sdk
from fastapi import FastAPI
from redis.asyncio import Redis
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db import get_session
from app.modules.jobs.errors import NotOnTheWayError
from app.modules.jobs.execution import JobExecutionService
from app.modules.jobs.location import (
    JobLocationStore,
    Position,
    ProLocationConfig,
    ProLocationService,
    RedisJobLocationStore,
    get_job_location_store,
    get_location_clock,
    location_backend,
)
from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.jobs.schemas import ProLocationIn
from app.modules.jobs.service import JobStateMachine
from app.modules.pros.service import ProService
from app.modules.users.models import User
from app.modules.users.types import UserAccount
from app.rate_limit import get_rate_limiter
from tests.conftest import (
    InMemoryJobLocationStore,
    InMemoryRateLimiter,
    _rolled_back_session,
    backend_pid,
    make_app,
    make_settings,
    wait_until_blocked,
)
from tests.helpers import log_fields, masked_fields
from tests.job_world import JobWorld, Party, build_world, job_row, make_job, record_pushes
from tests.test_arrival_code import CONFIG as EXECUTION_CONFIG
from tests.test_arrival_code import CommittedJob, committed_job, no_storage
from tests.test_requests_api import RecordingQueue
from tests.test_saved_addresses_api import counted_statements
from tests.test_sentry_scrubbing import TEST_DSN, MemoryTransport, _payloads, sentry_transport

__all__ = ["committed_job", "sentry_transport"]  # fixtures, used by name

NOW = datetime(2026, 11, 10, 15, 0, tzinfo=UTC)
CODE = "0427"
TTL = 120
# The most of the retention a test's own steps may use up between a write and its reading of
# the expiry: the time left must be the configured retention less this, at the least.
RETENTION_SLACK_SECONDS = 5
# Not the default: the retention comes from settings.
OTHER_TTL = 45
STORE_TIMEOUT = 2.0
# Coordinates no id, time or other number of a response or a log line looks like.
LAT, LNG = 26.123457, -80.143219
LAT2, LNG2 = 26.234568, -80.254321
NEEDLES = ("26.1234", "80.1432", "26.2345", "80.2543", "95.1234")
NO_POSITION = {"position": None}
NOT_FOUND = {"error": {"code": "not_found", "message": "Resource not found."}}
FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}
VALIDATION = {"error": {"code": "validation_error", "message": "The request is invalid."}}
NOT_ON_THE_WAY = {"error": {"code": "not_on_the_way", "message": "The job is not on the way."}}
UNAVAILABLE = {
    "error": {
        "code": "location_unavailable",
        "message": "Location sharing is unavailable right now. Try again later.",
    }
}
RATE_LIMITED = {"error": {"code": "rate_limited", "message": "Too many requests. Try again later."}}
LOCATION_CONFIG = ProLocationConfig(
    ttl_seconds=TTL,
    min_interval=timedelta(seconds=3),
    max_future=timedelta(minutes=5),
    max_age=timedelta(minutes=10),
)


@pytest.fixture
def settings(request: pytest.FixtureRequest) -> Settings:
    return make_settings(**getattr(request, "param", {}))


@pytest.fixture
async def redis() -> AsyncIterator[Redis]:
    client = Redis.from_url(Settings().redis_url)
    try:
        yield client
    finally:
        await client.aclose()


@pytest.fixture
async def prefix(redis: Redis) -> AsyncIterator[str]:
    prefix = f"jobloc-test-{uuid.uuid4().hex}"
    yield prefix
    keys = [key async for key in redis.scan_iter(match=f"{prefix}:*")]
    if keys:
        await redis.delete(*keys)


@pytest.fixture
def clock(app: FastAPI) -> list[datetime]:
    """The server's time for positions and for the per-pro limit's window; a test moves it by
    setting clock[0]."""
    now = [NOW]
    app.dependency_overrides[get_location_clock] = lambda: lambda: now[0]
    limiter = InMemoryRateLimiter(clock=lambda: now[0].timestamp())
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    return now


@pytest.fixture
def store(app: FastAPI, redis: Redis, prefix: str, clock: list[datetime]) -> RedisJobLocationStore:
    store = RedisJobLocationStore(redis, timeout_seconds=STORE_TIMEOUT, prefix=prefix)
    app.dependency_overrides[get_job_location_store] = lambda: store
    return store


@pytest.fixture(autouse=True)
def queue(app: FastAPI) -> RecordingQueue:
    """The job pushes (#65) are queued here, never on Redis."""
    return record_pushes(app)


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


def url(job_id: uuid.UUID) -> str:
    return f"/v1/jobs/{job_id}/pro-location"


def fix(at: datetime = NOW, **fields: Any) -> dict[str, Any]:
    return {
        "lat": LAT,
        "lng": LNG,
        "accuracy_m": 12.5,
        "heading_deg": 271.0,
        "recorded_at": at.isoformat(),
        **fields,
    }


def position(at: datetime = NOW, lat: float = LAT, lng: float = LNG) -> Position:
    return Position(
        lat=lat, lng=lng, accuracy_m=12.5, heading_deg=271.0, recorded_at=at, updated_at=at
    )


async def plant(store: JobLocationStore, job_id: uuid.UUID, at: datetime = NOW) -> None:
    """A position as a ping left it, written past the service."""
    assert await store.put(job_id, position(at), min_interval=timedelta(0), ttl_seconds=TTL)


async def assert_kept_for(
    redis: Redis, store: RedisJobLocationStore, job_id: uuid.UUID, ttl_seconds: int
) -> None:
    """Read just after a write, the time Redis will still keep the job's position is the
    configured retention, less the little that passed (PTTL: milliseconds, not rounded). A
    shorter expiry than the setting fails, and so does a longer one."""
    left = await redis.pttl(store.key(job_id)) / 1000
    assert ttl_seconds - RETENTION_SLACK_SECONDS <= left <= ttl_seconds, left


async def on_the_way_job(session: AsyncSession, world: JobWorld, **fields: Any) -> Job:
    fields.setdefault("arrival_code", CODE)
    fields.setdefault("eta_at", datetime.now(UTC) + timedelta(minutes=30))
    return await make_job(session, world, JobStatus.ON_THE_WAY, **fields)


async def ping(
    client: httpx.AsyncClient, job_id: uuid.UUID, party: Party, body: dict[str, Any] | None = None
) -> httpx.Response:
    return await client.put(
        url(job_id), json=fix() if body is None else body, headers=party.headers
    )


async def read(client: httpx.AsyncClient, job_id: uuid.UUID, party: Party) -> httpx.Response:
    return await client.get(url(job_id), headers=party.headers)


async def shown(client: httpx.AsyncClient, job_id: uuid.UUID, world: JobWorld) -> Any:
    response = await read(client, job_id, world.customer)
    assert response.status_code == 200, response.text
    return response.json()["position"]


async def account(session: AsyncSession, user_id: uuid.UUID) -> UserAccount:
    user = await session.get(User, user_id)
    assert user is not None
    return UserAccount(
        id=user.id,
        email=user.email,
        role=user.role,
        locale=user.locale,
        status=user.status,
        public_code=user.public_code,
        created_at=user.created_at,
    )


# Criterion 1: the pro pings, the customer reads


async def test_pro_ping_is_readable_by_the_customer(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    redis: Redis,
    prefix: str,
    clock: list[datetime],
    settings: Settings,
) -> None:
    job = await on_the_way_job(db_session, world)
    assert await shown(db_client, job.id, world) is None  # before the first ping
    events_before = await db_session.scalar(select(func.count()).select_from(JobEvent))
    taken = NOW - timedelta(seconds=20)  # the device's time: not what the customer gets

    with counted_statements(db_session) as statements:
        sent = await ping(db_client, job.id, world.pro, fix(taken))

    assert sent.status_code == 204, sent.text
    assert sent.content == b""
    clock[0] = NOW + timedelta(seconds=7)  # reading later does not move updated_at
    assert await shown(db_client, job.id, world) == {
        "lat": LAT,
        "lng": LNG,
        "accuracy_m": 12.5,
        "heading_deg": 271.0,
        "updated_at": "2026-11-10T15:00:00Z",
    }
    # Redis only: one key, which expires after the configured retention; the ping read the
    # database and wrote nothing to it.
    keys = [key.decode() async for key in redis.scan_iter(match=f"{prefix}:*")]
    assert keys == [f"{prefix}:{job.id}"]
    await assert_kept_for(redis, store, job.id, settings.pro_location_ttl_seconds)
    assert statements
    assert all(s.lstrip().upper().startswith("SELECT") for s in statements), statements
    assert await db_session.scalar(select(func.count()).select_from(JobEvent)) == events_before


async def test_accuracy_and_heading_are_optional(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, store: JobLocationStore
) -> None:
    job = await on_the_way_job(db_session, world)
    body = {"lat": 26, "lng": -80, "recorded_at": NOW.isoformat()}  # whole numbers are numbers

    assert (await ping(db_client, job.id, world.pro, body)).status_code == 204

    assert await shown(db_client, job.id, world) == {
        "lat": 26.0,
        "lng": -80.0,
        "accuracy_m": None,
        "heading_deg": None,
        "updated_at": "2026-11-10T15:00:00Z",
    }


@pytest.mark.parametrize(
    ("recorded_at", "status"),
    [
        ((NOW + timedelta(minutes=5)).isoformat(), 204),
        ((NOW + timedelta(minutes=5, seconds=1)).isoformat(), 422),
        ((NOW - timedelta(minutes=10)).isoformat(), 204),
        ((NOW - timedelta(minutes=10, seconds=1)).isoformat(), 422),
        # The same instant with another offset is the same instant.
        ("2026-11-10T10:00:00-05:00", 204),
        # No offset: whose clock is it? And the edges of the calendar, which overflow in UTC.
        ("2026-11-10T15:00:00", 422),
        ("0001-01-01T00:00:00+14:00", 422),
        ("9999-12-31T23:59:59-14:00", 422),
    ],
)
async def test_recorded_at_outside_the_window_is_422(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: JobLocationStore,
    recorded_at: str,
    status: int,
) -> None:
    job = await on_the_way_job(db_session, world)

    response = await ping(db_client, job.id, world.pro, fix(recorded_at=recorded_at))

    assert response.status_code == status, response.text
    if status == 422:
        assert response.json() == VALIDATION
        assert await store.get(job.id) is None


# Criterion 2: the newest fix wins


async def test_newer_ping_replaces_the_older(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    redis: Redis,
    clock: list[datetime],
    settings: Settings,
) -> None:
    job = await on_the_way_job(db_session, world)
    assert (await ping(db_client, job.id, world.pro)).status_code == 204
    # As if most of the first one's retention had passed.
    assert await redis.expire(store.key(job.id), 50)

    clock[0] = NOW + timedelta(seconds=10)
    newer = fix(clock[0], lat=LAT2, lng=LNG2, accuracy_m=None, heading_deg=None)
    assert (await ping(db_client, job.id, world.pro, newer)).status_code == 204

    # The newer one is kept for the whole configured retention, counted from its own write.
    await assert_kept_for(redis, store, job.id, settings.pro_location_ttl_seconds)
    assert await shown(db_client, job.id, world) == {
        "lat": LAT2,
        "lng": LNG2,
        "accuracy_m": None,  # nothing of the older one is left
        "heading_deg": None,
        "updated_at": "2026-11-10T15:00:10Z",
    }


async def test_older_ping_is_ignored(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: JobLocationStore,
    clock: list[datetime],
) -> None:
    job = await on_the_way_job(db_session, world)
    assert (await ping(db_client, job.id, world.pro)).status_code == 204
    first = await store.get(job.id)

    clock[0] = NOW + timedelta(seconds=10)  # long after the first: only its age refuses it
    late = fix(NOW - timedelta(seconds=1), lat=LAT2, lng=LNG2)
    response = await ping(db_client, job.id, world.pro, late)

    assert response.status_code == 204, response.text
    assert await store.get(job.id) == first
    assert (await shown(db_client, job.id, world))["updated_at"] == "2026-11-10T15:00:00Z"
    # One taken at the very same moment is not older: it is kept.
    same = fix(NOW, lat=LAT2, lng=LNG2)
    assert (await ping(db_client, job.id, world.pro, same)).status_code == 204
    assert (await shown(db_client, job.id, world))["lat"] == LAT2


# Criterion 3: too often is ignored, a flood is limited


async def test_ping_faster_than_3s_is_ignored(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    redis: Redis,
    clock: list[datetime],
) -> None:
    job = await on_the_way_job(db_session, world)
    assert (await ping(db_client, job.id, world.pro)).status_code == 204
    first = await store.get(job.id)
    assert await redis.expire(store.key(job.id), 50)

    clock[0] = NOW + timedelta(seconds=2, milliseconds=999)
    soon = await ping(db_client, job.id, world.pro, fix(clock[0], lat=LAT2, lng=LNG2))

    assert soon.status_code == 204, soon.text  # never an error to the pro's background task
    assert soon.content == b""
    assert await store.get(job.id) == first
    assert await redis.ttl(store.key(job.id)) <= 50  # nor does it keep the old one alive
    # Three seconds after the stored one, the next is news.
    clock[0] = NOW + timedelta(seconds=3)
    assert (await ping(db_client, job.id, world.pro, fix(clock[0], lat=LAT2))).status_code == 204
    assert (await shown(db_client, job.id, world))["updated_at"] == "2026-11-10T15:00:03Z"


@pytest.mark.parametrize("settings", [{"pro_location_min_interval_seconds": 0}], indirect=True)
async def test_min_interval_comes_from_settings(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, store: JobLocationStore
) -> None:
    job = await on_the_way_job(db_session, world)
    assert (await ping(db_client, job.id, world.pro)).status_code == 204

    assert (await ping(db_client, job.id, world.pro, fix(lat=LAT2))).status_code == 204

    assert (await shown(db_client, job.id, world))["lat"] == LAT2


@pytest.mark.parametrize(
    "settings",
    [{"pro_location_rate_limit": 3, "pro_location_rate_window_seconds": 60}],
    indirect=True,
)
async def test_flood_past_the_per_pro_limit_is_429(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: JobLocationStore,
    clock: list[datetime],
) -> None:
    job = await on_the_way_job(db_session, world)
    other = await on_the_way_job(db_session, world, pro=world.other_pro)
    # Three within the limit, whatever becomes of each: kept, ignored, refused.
    assert (await ping(db_client, job.id, world.pro)).status_code == 204
    assert (await ping(db_client, job.id, world.pro)).status_code == 204
    assert (await ping(db_client, uuid.uuid4(), world.pro)).status_code == 404

    flood = [
        await ping(db_client, job.id, world.pro),
        await ping(db_client, uuid.uuid4(), world.pro),  # per pro, not per job: before the job
        await ping(db_client, job.id, world.pro, {"lat": "x"}),  # and before the body
    ]

    for response in flood:
        assert response.status_code == 429, response.text
        assert response.json() == RATE_LIMITED
        assert response.headers["Retry-After"] == "60"
    # Another pro is not held back, and the next window starts over.
    assert (await ping(db_client, other.id, world.other_pro)).status_code == 204
    clock[0] = NOW + timedelta(seconds=60)
    assert (await ping(db_client, job.id, world.pro, fix(clock[0]))).status_code == 204


# Criterion 4: not on the way


NOT_TRACKED: list[tuple[JobStatus, dict[str, Any]]] = [
    (status, {}) for status in JobStatus if status is not JobStatus.ON_THE_WAY
] + [(JobStatus.ON_THE_WAY, {"checked_in_at": NOW})]


@pytest.mark.parametrize(
    ("status", "fields"),
    NOT_TRACKED,
    ids=[f"{s.value}{'-arrived' if f else ''}" for s, f in NOT_TRACKED],
)
async def test_not_on_the_way_is_409_for_pro_and_empty_for_customer(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: JobLocationStore,
    status: JobStatus,
    fields: dict[str, Any],
) -> None:
    waiting = await on_the_way_job(db_session, world)  # on the way, no ping yet
    job = await make_job(db_session, world, status, **fields)
    # A position left behind (a delete Redis missed) is still never shown, nor replaced.
    await plant(store, job.id)
    left = await store.get(job.id)

    refused = await ping(db_client, job.id, world.pro, fix(lat=LAT2, lng=LNG2))
    answer = await read(db_client, job.id, world.customer)

    assert refused.status_code == 409, refused.text
    assert refused.json() == NOT_ON_THE_WAY
    assert await store.get(job.id) == left
    # The very answer of a job on the way before its first ping: no oracle of the status.
    before_first = await read(db_client, waiting.id, world.customer)
    assert (answer.status_code, answer.json()) == (200, NO_POSITION)
    assert (before_first.status_code, before_first.content) == (200, answer.content)


# Criterion 5: the position ends with the tracking


async def test_position_deleted_on_arrival_and_cancel(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    redis: Redis,
) -> None:
    arriving = await on_the_way_job(db_session, world)
    cancelled = await on_the_way_job(db_session, world)
    for job in (arriving, cancelled):
        assert (await ping(db_client, job.id, world.pro)).status_code == 204
        assert await redis.exists(store.key(job.id)) == 1

    # A wrong code is no arrival: the position stays.
    wrong = await db_client.post(
        f"/v1/pros/me/jobs/{arriving.id}/check-in",
        json={"arrival_code": "9999", "lat": LAT, "lng": LNG},
        headers=world.pro.headers,
    )
    assert wrong.status_code == 422
    assert await redis.exists(store.key(arriving.id)) == 1

    checked_in = await db_client.post(
        f"/v1/pros/me/jobs/{arriving.id}/check-in",
        json={"arrival_code": CODE, "lat": LAT, "lng": LNG},
        headers=world.pro.headers,
    )
    customer = await account(db_session, world.customer.id)
    machine = JobStateMachine(db_session, ProService(db_session), store)
    await machine.transition(cancelled.id, JobStatus.CANCELLED, customer)
    await db_session.commit()

    assert checked_in.status_code == 200, checked_in.text
    assert (await job_row(db_session, arriving.id)).status is JobStatus.ON_THE_WAY  # arrived
    for job in (arriving, cancelled):
        assert await redis.exists(store.key(job.id)) == 0
        assert await shown(db_client, job.id, world) is None
        # And the pro's app, still sending, cannot bring it back.
        late = await ping(db_client, job.id, world.pro, fix(NOW + timedelta(seconds=30)))
        assert (late.status_code, late.json()) == (409, NOT_ON_THE_WAY)
        assert await redis.exists(store.key(job.id)) == 0


async def test_position_deleted_when_the_job_starts(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    redis: Redis,
) -> None:
    # Checked in, with a position the check-in's delete missed: any way out of on_the_way
    # deletes it again.
    job = await on_the_way_job(db_session, world, checked_in_at=NOW, arrival_code=None)
    await plant(store, job.id)

    started = await db_client.post(f"/v1/pros/me/jobs/{job.id}/start", headers=world.pro.headers)

    assert started.status_code == 200, started.text
    assert started.json()["status"] == "in_progress"
    assert await redis.exists(store.key(job.id)) == 0


async def test_position_expires_on_its_own(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    redis: Redis,
    settings: Settings,
) -> None:
    job = await on_the_way_job(db_session, world)
    assert (await ping(db_client, job.id, world.pro)).status_code == 204
    await assert_kept_for(redis, store, job.id, settings.pro_location_ttl_seconds)

    # An expiry time already past: Redis drops the key at once, no waiting.
    assert await redis.pexpireat(store.key(job.id), 1)

    assert await redis.exists(store.key(job.id)) == 0
    assert await shown(db_client, job.id, world) is None


@pytest.mark.parametrize("settings", [{"pro_location_ttl_seconds": OTHER_TTL}], indirect=True)
async def test_retention_comes_from_settings(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    redis: Redis,
    clock: list[datetime],
    settings: Settings,
) -> None:
    """PRO_LOCATION_TTL_SECONDS is how long a kept ping, and one that replaces it, stay: not
    the default, not a constant of the code."""
    assert settings.pro_location_ttl_seconds == OTHER_TTL
    assert OTHER_TTL < TTL - RETENTION_SLACK_SECONDS  # the default would fail the checks below
    job = await on_the_way_job(db_session, world)

    assert (await ping(db_client, job.id, world.pro)).status_code == 204
    await assert_kept_for(redis, store, job.id, OTHER_TTL)

    assert await redis.expire(store.key(job.id), 10)
    clock[0] = NOW + timedelta(seconds=10)
    replacing = fix(clock[0], lat=LAT2, lng=LNG2)
    assert (await ping(db_client, job.id, world.pro, replacing)).status_code == 204
    await assert_kept_for(redis, store, job.id, OTHER_TTL)


async def test_leaving_on_the_way_without_the_store_is_refused(
    db_session: AsyncSession, world: JobWorld
) -> None:
    """A machine or a service built without the store fails before it changes anything, instead
    of leaving a position behind."""
    job = await on_the_way_job(db_session, world)
    pro = await account(db_session, world.pro.id)

    with pytest.raises(RuntimeError, match="location store"):
        await JobStateMachine(db_session, ProService(db_session)).transition(
            job.id, JobStatus.CANCELLED, pro
        )
    with pytest.raises(RuntimeError, match="location store"):
        await JobExecutionService(db_session, EXECUTION_CONFIG, no_storage).check_in(
            pro, job.id, CODE, LAT, LNG, RecordingQueue()
        )

    row = await job_row(db_session, job.id)
    assert (row.status, row.checked_in_at) == (JobStatus.ON_THE_WAY, None)


async def test_ping_waits_for_a_status_change_and_is_refused(committed_job: CommittedJob) -> None:
    """Real commits: a ping that arrives while the job is leaving on_the_way waits for that
    transaction, then finds the job gone from on_the_way. It never writes a position the
    status change's delete has already passed."""
    store = InMemoryJobLocationStore()
    await plant(store, committed_job.job_id)
    data = ProLocationIn.model_validate(fix(NOW + timedelta(seconds=10)))

    async with committed_job.sessions() as leaving, committed_job.sessions() as pinging:
        machine = JobStateMachine(leaving, ProService(leaving), store)
        await machine.transition(committed_job.job_id, JobStatus.CANCELLED, committed_job.pro)
        assert await store.get(committed_job.job_id) is None  # deleted, not committed yet
        service = ProLocationService(
            pinging, LOCATION_CONFIG, store, lambda: NOW + timedelta(seconds=10)
        )
        waiter, holder = await backend_pid(pinging), await backend_pid(leaving)
        late = asyncio.create_task(service.ping(committed_job.pro, committed_job.job_id, data))
        try:
            await wait_until_blocked(committed_job.sessions, waiter=waiter, holder=holder)
            assert await store.get(committed_job.job_id) is None
            await leaving.commit()
            with pytest.raises(NotOnTheWayError):
                await late
        finally:
            late.cancel()

    assert await store.get(committed_job.job_id) is None


# Criterion 6: only the job's own pro writes, only its own customer reads


async def test_only_the_parties_reach_the_position(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, store: JobLocationStore
) -> None:
    job = await on_the_way_job(db_session, world)
    await plant(store, job.id)
    left = await store.get(job.id)
    body = fix(NOW + timedelta(seconds=10), lat=LAT2, lng=LNG2)

    writes = {
        name: await ping(db_client, job.id, party, body)
        for name, party in [
            ("other_pro", world.other_pro),
            ("pro_without_profile", world.pro_without_profile),
            ("customer", world.customer),
            ("other_customer", world.other_customer),
            ("agent", world.agent),
            ("admin", world.admin),
        ]
    }
    reads = {
        name: await read(db_client, job.id, party)
        for name, party in [
            ("other_customer", world.other_customer),
            ("pro", world.pro),  # even the job's own pro: the customer's read only
            ("other_pro", world.other_pro),
            ("agent", world.agent),
            ("admin", world.admin),
        ]
    }
    anonymous = [await db_client.put(url(job.id), json=body), await db_client.get(url(job.id))]

    assert {name: (r.status_code, r.json()) for name, r in writes.items()} == {
        "other_pro": (404, NOT_FOUND),
        "pro_without_profile": (404, NOT_FOUND),
        "customer": (403, FORBIDDEN),
        "other_customer": (403, FORBIDDEN),
        "agent": (403, FORBIDDEN),
        "admin": (403, FORBIDDEN),
    }
    assert {name: (r.status_code, r.json()) for name, r in reads.items()} == {
        "other_customer": (404, NOT_FOUND),
        "pro": (403, FORBIDDEN),
        "other_pro": (403, FORBIDDEN),
        "agent": (403, FORBIDDEN),
        "admin": (403, FORBIDDEN),
    }
    assert [r.status_code for r in anonymous] == [401, 401]
    for response in (*writes.values(), *reads.values(), *anonymous):
        assert not any(needle in response.text for needle in NEEDLES)
    assert await store.get(job.id) == left  # nobody wrote
    # A job that does not exist answers the stranger's 404.
    missing = uuid.uuid4()
    assert (await ping(db_client, missing, world.pro)).json() == NOT_FOUND
    assert (await read(db_client, missing, world.customer)).json() == NOT_FOUND


async def test_foreign_and_missing_job_cost_the_same(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, store: JobLocationStore
) -> None:
    job = await on_the_way_job(db_session, world)
    await plant(store, job.id)
    job_id = job.id
    seen: dict[str, list[str]] = {}

    for name, target in [("foreign", job_id), ("missing", uuid.uuid4())]:
        # Every request starts with an empty session, as in production: no row comes from the
        # test's identity map without its query.
        db_session.expunge_all()
        with counted_statements(db_session) as statements:
            put = await ping(db_client, target, world.other_pro)
        seen[f"put {name}"] = list(statements)
        db_session.expunge_all()
        with counted_statements(db_session) as statements:
            got = await read(db_client, target, world.other_customer)
        seen[f"get {name}"] = list(statements)
        assert (put.status_code, put.content, got.status_code, got.content) == (
            404,
            b'{"error":{"code":"not_found","message":"Resource not found."}}',
            404,
            b'{"error":{"code":"not_found","message":"Resource not found."}}',
        )

    # The caller's account, their pro profile, the job: the same queries, found or not.
    assert seen["put foreign"] == seen["put missing"], seen
    assert len(seen["put foreign"]) == 3, seen
    # The caller's account, the job.
    assert seen["get foreign"] == seen["get missing"], seen
    assert len(seen["get foreign"]) == 2, seen


# Criterion 7: validation

# Raw JSON tokens: NaN and Infinity are not JSON, yet Python's parser reads them.
VALID_TOKENS = {"lat": "26.1", "lng": "-80.1", "recorded_at": '"2026-11-10T15:00:00Z"'}


def raw(**tokens: str | None) -> bytes:
    """A body of VALID_TOKENS with these tokens set, added, or (None) left out."""
    merged = {**VALID_TOKENS, **tokens}
    fields = ", ".join(f'"{name}": {token}' for name, token in merged.items() if token is not None)
    return ("{" + fields + "}").encode()


@pytest.mark.parametrize(
    "body",
    [
        raw(lat="90.0001"),
        raw(lat="-90.0001"),
        raw(lat="95.123457"),
        raw(lng="180.0001"),
        raw(lng="-180.0001"),
        raw(lat="NaN"),
        raw(lng="Infinity"),
        raw(lng="-Infinity"),
        raw(lat="1e999"),
        raw(accuracy_m="-0.1"),
        raw(accuracy_m="10000.1"),
        raw(accuracy_m="NaN"),
        raw(heading_deg="-0.1"),
        raw(heading_deg="360.1"),
        raw(heading_deg="Infinity"),
        # Extra fields
        raw(speed="3"),
        raw(job_id='"x"'),
        raw(updated_at="1"),
        # Wrong types: a number is a number, never a string or a boolean
        raw(lat='"26.1"'),
        raw(lat="true"),
        raw(lat="null"),
        raw(lat="[26.1]"),
        raw(lng='{"value": -80.1}'),
        raw(accuracy_m='"12"'),
        raw(heading_deg='"north"'),
        raw(recorded_at='"just now"'),
        raw(recorded_at="null"),
        raw(recorded_at="true"),
        # Missing, or not an object at all
        raw(lat=None),
        raw(lng=None),
        raw(recorded_at=None),
        b"{}",
        b"[]",
        b"null",
        b'{"lat": 26.1,',
        b"",
    ],
)
async def test_invalid_positions_are_422(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: JobLocationStore,
    body: bytes,
) -> None:
    job = await on_the_way_job(db_session, world)

    response = await db_client.put(
        url(job.id),
        content=body,
        headers={**world.pro.headers, "Content-Type": "application/json"},
    )

    assert response.status_code == 422, response.text
    assert response.json() == VALIDATION  # and nothing of what was sent
    assert await store.get(job.id) is None


@pytest.mark.parametrize(
    "fields",
    [
        {"lat": 90, "lng": 180},
        {"lat": -90, "lng": -180},
        {"accuracy_m": 0, "heading_deg": 0},
        {"accuracy_m": 10_000, "heading_deg": 360},
    ],
)
async def test_the_edges_of_each_range_are_valid(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: JobLocationStore,
    fields: dict[str, Any],
) -> None:
    job = await on_the_way_job(db_session, world)

    assert (await ping(db_client, job.id, world.pro, fix(**fields))).status_code == 204

    stored = await shown(db_client, job.id, world)
    assert {name: stored[name] for name in fields} == fields


# Criterion 8: Redis down or slow


@pytest.fixture
async def dead_redis() -> AsyncIterator[Redis]:
    client = Redis.from_url("redis://127.0.0.1:1/0", socket_connect_timeout=0.2)
    try:
        yield client
    finally:
        await client.aclose()


@pytest.fixture
async def hung_redis(silent_redis_url: str) -> AsyncIterator[Redis]:
    client = Redis.from_url(silent_redis_url)
    try:
        yield client
    finally:
        await client.aclose()


@pytest.mark.parametrize("settings", [{"pro_location_timeout_seconds": 0.3}], indirect=True)
@pytest.mark.parametrize("broken", ["dead_redis", "hung_redis"])
async def test_redis_down_does_not_500(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: list[datetime],
    dead_redis: Redis,
    hung_redis: Redis,
    caplog: pytest.LogCaptureFixture,
    settings: Settings,
    broken: str,
) -> None:
    # The app's own store, as startup builds it for these settings (no LOCATION_REDIS_URL in
    # test: the app's Redis), with the timeout Settings gives it: the check of what that Redis
    # keeps and the operation end within it together.
    broken_redis = {"dead_redis": dead_redis, "hung_redis": hung_redis}[broken]
    app.state.location_backend = location_backend(settings, broken_redis)
    del app.dependency_overrides[get_job_location_store]
    job = await on_the_way_job(db_session, world)
    ids = {"job_id": str(job.id), "pro_id": str(world.pro.profile_id)}
    started_at = time.monotonic()

    with caplog.at_level(logging.DEBUG):
        sent = await ping(db_client, job.id, world.pro)
        got = await read(db_client, job.id, world.customer)
        # A job step never waits for, or fails with, the delete.
        checked_in = await db_client.post(
            f"/v1/pros/me/jobs/{job.id}/check-in",
            json={"arrival_code": CODE, "lat": LAT, "lng": LNG},
            headers=world.pro.headers,
        )
        started = await db_client.post(
            f"/v1/pros/me/jobs/{job.id}/start", headers=world.pro.headers
        )

    # Four calls on Redis, each ended by the 0.3 s of Settings (not by a client default).
    assert time.monotonic() - started_at < 4
    assert (sent.status_code, sent.json()) == (503, UNAVAILABLE)
    assert (got.status_code, got.json()) == (200, NO_POSITION)
    assert checked_in.status_code == 200, checked_in.text
    assert checked_in.json()["checked_in_at"] is not None
    assert (started.status_code, started.json()["status"]) == (200, "in_progress")
    logged = [
        (r.levelname, r.getMessage(), getattr(r, "job_id", None), getattr(r, "pro_id", None))
        for r in caplog.records
        if r.name == "app.modules.jobs.location"
    ]
    assert logged == [
        ("ERROR", "pro_location_unavailable", ids["job_id"], ids["pro_id"]),
        ("ERROR", "pro_location_unavailable", ids["job_id"], None),
        ("ERROR", "pro_location_delete_failed", ids["job_id"], None),
        ("ERROR", "pro_location_delete_failed", ids["job_id"], None),
    ]
    assert not any(r.exc_info for r in caplog.records)  # no driver text, no script arguments


# Criterion 9: no coordinate in logs or errors


async def test_no_coordinate_in_logs(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    dead_redis: Redis,
    clock: list[datetime],
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await on_the_way_job(db_session, world)
    done = await make_job(db_session, world, JobStatus.COMPLETED)
    down = RedisJobLocationStore(dead_redis, timeout_seconds=0.3, prefix="jobloc-test-down")
    errors: list[httpx.Response] = []

    with caplog.at_level(logging.DEBUG):
        assert (await ping(db_client, job.id, world.pro)).status_code == 204  # kept
        errors.append(await ping(db_client, job.id, world.pro, fix(lat=LAT2, lng=LNG2)))  # ignored
        assert await shown(db_client, job.id, world) is not None
        errors.append(await ping(db_client, job.id, world.pro, fix(lat=95.123457)))  # 422
        errors.append(await ping(db_client, job.id, world.pro, fix(NOW + timedelta(days=1))))  # 422
        errors.append(await ping(db_client, done.id, world.pro))  # 409
        errors.append(await ping(db_client, job.id, world.other_pro))  # 404
        errors.append(await ping(db_client, job.id, world.customer))  # 403
        app.dependency_overrides[get_job_location_store] = lambda: down
        errors.append(await ping(db_client, job.id, world.pro, fix(lat=LAT2, lng=LNG2)))  # 503
        errors.append(await read(db_client, job.id, world.customer))  # no position
        errors.append(
            await db_client.post(
                f"/v1/pros/me/jobs/{job.id}/check-in",
                json={"arrival_code": CODE, "lat": 28.5, "lng": -81.3},
                headers=world.pro.headers,
            )
        )  # the delete fails

    assert [r.status_code for r in errors] == [204, 422, 422, 409, 404, 403, 503, 200, 200]
    logs = log_fields(caplog.records)
    events = {r.getMessage() for r in caplog.records if r.name == "app.modules.jobs.location"}
    assert events == {
        "pro_location_updated",
        "pro_location_ignored",
        "pro_location_unavailable",
        "pro_location_delete_failed",
    }
    for needle in NEEDLES:
        assert [field for field in logs if needle in field] == [], needle
        for response in errors[:-1]:  # the check-in answers the job, which has no position
            assert needle not in response.text, needle
    # Ids and the event name only.
    for record in caplog.records:
        if record.name == "app.modules.jobs.location":
            extras = set(vars(record)) - set(vars(logging.makeLogRecord({})))
            assert extras <= {"job_id", "pro_id", "request_id", "message", "asctime"}, extras


class FailsAfterWriting(RedisJobLocationStore):
    """Writes the position to Redis, then fails as an unexpected bug would."""

    async def put(
        self, job_id: uuid.UUID, position: Position, *, min_interval: timedelta, ttl_seconds: int
    ) -> bool:
        await super().put(job_id, position, min_interval=min_interval, ttl_seconds=ttl_seconds)
        raise RuntimeError("after the write")


async def test_no_coordinate_reaches_sentry(
    sentry_transport: MemoryTransport,
    db_session: AsyncSession,
    world: JobWorld,
    redis: Redis,
    prefix: str,
    dead_redis: Redis,
) -> None:
    """Sentry on, sending to memory. An unexpected error inside a ping, after the real Redis
    write (its event carries the request and its breadcrumbs, the Redis call among them), and
    a ping while the store is down (the ERROR log is an event): no coordinate in either."""
    app = make_app(make_settings(sentry_dsn=TEST_DSN))
    record_pushes(app)
    app.dependency_overrides[get_location_clock] = lambda: lambda: NOW
    app.state.rolled_back_session = db_session
    app.dependency_overrides[get_session] = _rolled_back_session
    failing = FailsAfterWriting(redis, timeout_seconds=STORE_TIMEOUT, prefix=prefix)
    down = RedisJobLocationStore(dead_redis, timeout_seconds=0.3, prefix="jobloc-test-down")
    job = await on_the_way_job(db_session, world)

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        app.dependency_overrides[get_job_location_store] = lambda: failing
        crashed = await ping(client, job.id, world.pro)
        written = await failing.get(job.id)
        app.dependency_overrides[get_job_location_store] = lambda: down
        unavailable = await ping(client, job.id, world.pro, fix(lat=LAT2, lng=LNG2))
    sentry_sdk.flush()

    assert crashed.status_code == 500, crashed.text
    assert written is not None  # the write was real: the coordinates went through Redis
    assert (written.lat, written.lng) == (LAT, LNG)
    assert (unavailable.status_code, unavailable.json()) == (503, UNAVAILABLE)
    payloads = _payloads(sentry_transport)
    events = [json.loads(payload) for payload in payloads]
    # Both failures were captured, and they are these requests' (the path names the job). The
    # crash's event has the write's own Redis call among its breadcrumbs: the command, its
    # arguments (the position) filtered.
    [crash] = [
        event
        for event in events
        if [value["type"] for value in event.get("exception", {}).get("values", [])]
        == ["RuntimeError"]
    ]
    assert str(job.id) in crash["request"]["url"]
    redis_calls = [
        crumb["message"]
        for crumb in crash["breadcrumbs"]["values"]
        if crumb.get("category") == "redis"
    ]
    assert redis_calls, "the write left no Redis breadcrumb"
    assert all(call.startswith("EVALSHA") for call in redis_calls), redis_calls
    assert any(
        event.get("logentry", {}).get("message") == "pro_location_unavailable" for event in events
    )
    # Field by field, keys too, ids and clocks masked: an event's time can read 12:00:26.1234
    # (#387).
    wire = masked_fields(events)
    for needle in NEEDLES:
        assert [field for field in wire if needle in field] == [], needle
    for response in (crashed, unavailable):
        for needle in NEEDLES:
            assert needle not in response.text, needle


# Criterion 10: the contract


def test_openapi_documents_the_position_routes(app: FastAPI) -> None:
    schema = app.openapi()
    path = schema["paths"]["/v1/jobs/{job_id}/pro-location"]

    assert set(path) == {"put", "get"}
    for operation in path.values():
        assert "never stored in the database" in operation["summary"]
    assert set(path["put"]["responses"]) == {"204", "401", "403", "404", "409", "422", "429", "503"}
    assert "content" not in path["put"]["responses"]["204"]
    assert set(path["get"]["responses"]) == {"200", "401", "403", "404", "422", "503"}
    schemas = schema["components"]["schemas"]
    ping_schema = schemas["ProLocationIn"]
    assert ping_schema["additionalProperties"] is False
    assert set(ping_schema["required"]) == {"lat", "lng", "recorded_at"}
    assert set(ping_schema["properties"]) == {
        "lat",
        "lng",
        "accuracy_m",
        "heading_deg",
        "recorded_at",
    }
    assert set(schemas["ProPosition"]["properties"]) == {
        "lat",
        "lng",
        "accuracy_m",
        "heading_deg",
        "updated_at",
    }
    assert set(schemas["ProLocationOut"]["required"]) == {"position"}


# The store's rules, the same in Redis and in the tests' in-memory stand-in


@pytest.fixture(params=["redis", "memory"])
def any_store(request: pytest.FixtureRequest) -> JobLocationStore:
    if request.param == "memory":
        return InMemoryJobLocationStore()
    redis: Redis = request.getfixturevalue("redis")
    prefix: str = request.getfixturevalue("prefix")
    return RedisJobLocationStore(redis, timeout_seconds=STORE_TIMEOUT, prefix=prefix)


async def test_store_keeps_only_news(any_store: JobLocationStore) -> None:
    job_id, other = uuid.uuid4(), uuid.uuid4()
    interval = timedelta(seconds=3)
    first = Position(
        lat=LAT,
        lng=LNG,
        accuracy_m=None,
        heading_deg=0.1 + 0.2,  # a float that only an exact round trip gives back
        recorded_at=NOW - timedelta(microseconds=1),
        updated_at=NOW,
    )

    async def put(recorded: timedelta, updated: timedelta, job: uuid.UUID = job_id) -> bool:
        candidate = Position(LAT2, LNG2, 5.0, None, NOW + recorded, NOW + updated)
        return await any_store.put(job, candidate, min_interval=interval, ttl_seconds=TTL)

    assert await any_store.get(job_id) is None
    assert await any_store.put(job_id, first, min_interval=interval, ttl_seconds=TTL)
    assert await any_store.get(job_id) == first
    # Too soon, by a microsecond; then older, by a microsecond, long after.
    assert not await put(timedelta(seconds=1), timedelta(seconds=3) - timedelta(microseconds=1))
    assert not await put(-timedelta(microseconds=2), timedelta(seconds=30))
    assert await any_store.get(job_id) == first
    # Another job has its own position.
    assert await put(timedelta(0), timedelta(0), other)
    assert await any_store.get(job_id) == first
    # At the interval exactly, and no older than the stored one: kept, whole.
    assert await put(-timedelta(microseconds=1), timedelta(seconds=3))
    kept = await any_store.get(job_id)
    assert kept == Position(
        LAT2, LNG2, 5.0, None, NOW - timedelta(microseconds=1), NOW + timedelta(seconds=3)
    )
    await any_store.delete(job_id)
    await any_store.delete(job_id)  # deleting nothing is fine
    assert await any_store.get(job_id) is None
    assert await any_store.get(other) is not None


async def test_redis_store_decides_concurrent_pings_in_one_step(redis: Redis, prefix: str) -> None:
    store = RedisJobLocationStore(redis, timeout_seconds=STORE_TIMEOUT, prefix=prefix)
    job_id = uuid.uuid4()

    kept = await asyncio.gather(
        *(
            store.put(
                job_id,
                Position(LAT, LNG, None, None, NOW + timedelta(seconds=n), NOW),
                min_interval=timedelta(seconds=3),
                ttl_seconds=TTL,
            )
            for n in range(20)
        )
    )

    assert sum(kept) == 1  # all "now": after the first, each of the others is too soon
    assert await redis.hlen(store.key(job_id)) == 3  # type: ignore[misc]  # redis-py's sync/async typing


async def test_redis_store_never_shows_a_value_it_did_not_write(redis: Redis, prefix: str) -> None:
    store = RedisJobLocationStore(redis, timeout_seconds=STORE_TIMEOUT, prefix=prefix)
    job_id = uuid.uuid4()
    for junk in ("not json", "[]", '{"lat": 1}', '{"lat": "x", "lng": 2}'):
        await redis.hset(store.key(job_id), "position", junk)  # type: ignore[misc]  # as above

        assert await store.get(job_id) is None
