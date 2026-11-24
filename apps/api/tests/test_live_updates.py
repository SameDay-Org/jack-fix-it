"""The live updates (#596, PR 2b): what goes out, to whom, when, and never after the job.

The senders are fakes, or Expo on a mock transport: never the network. The guard runs in the
real Redis of REDIS_URL under a prefix of the test's own, deleted afterwards.
"""

import asyncio
import json
import logging
import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any, cast

import httpx
import pytest
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.integrations.expo_push import ExpoPushSender
from app.integrations.live_updates import (
    ApnsLiveActivitySender,
    ExpoAndroidLiveSender,
    LiveTargets,
    LiveUpdate,
    PushLiveUpdateSender,
)
from app.modules.devices.models import Device, DevicePlatform
from app.modules.devices.service import DeviceService
from app.modules.jobs.live import JobLiveConfig, JobLiveService
from app.modules.jobs.live_updates import (
    STAGE_RANK,
    LiveUpdateDeps,
    LiveUpdateService,
    RedisLiveUpdateGuard,
    kick_live_update,
    live_update_deps,
    send_live_update,
    send_live_updates,
    sweep_live_updates,
)
from app.modules.jobs.location import KEY_PREFIX, location_store_of
from app.modules.jobs.location_guard import LocationStoreRefusedError
from app.modules.jobs.models import Job, JobStatus, LiveActivityToken
from app.modules.jobs.route import JobRouteConfig, JobRouteService
from app.modules.jobs.schemas import JobLiveOut, LiveStage
from tests.conftest import InMemoryJobLocationStore, InMemoryJobRouteCache, make_settings
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
from tests.test_job_live_api import NEEDLES
from tests.test_job_route_api import FakeMapbox, drive, locate
from tests.test_orphan_uploads import sessions_of
from tests.test_pro_location_api import CODE, on_the_way_job, plant, prefix, redis
from tests.test_requests_api import RecordingQueue

# Fixtures, used by name.
__all__ = ["prefix", "redis"]

T0 = datetime(2026, 11, 24, 12, 0, tzinfo=UTC)
INTERVAL = 90  # LIVE_UPDATE_INTERVAL_SECONDS here: a fixture value, not the default
TOKEN = "a1b2c3d4" * 8


class RecordingSender:
    def __init__(self) -> None:
        self.sent: list[tuple[LiveUpdate, LiveTargets]] = []

    async def send(self, update: LiveUpdate, targets: LiveTargets) -> None:
        self.sent.append((update, targets))


class FakeLive:
    """The live views the service reads: set per job by the test; None is not under way."""

    def __init__(self) -> None:
        self.views: dict[uuid.UUID, JobLiveOut | None] = {}

    async def current(self, job_id: uuid.UUID) -> JobLiveOut | None:
        return self.views.get(job_id)


def view(stage: LiveStage, eta: int | None = None, at: datetime = T0) -> JobLiveOut:
    return JobLiveOut(
        job_public_code="JF-000777",
        stage=stage,
        eta_seconds=eta,
        distance_meters=None if eta is None else eta * 10,
        progress=0.25,
        updated_at=at,
    )


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


@pytest.fixture
def guard(redis: Redis, prefix: str) -> RedisLiveUpdateGuard:
    return RedisLiveUpdateGuard(
        redis, None, interval_seconds=INTERVAL, ttl_seconds=600, timeout_seconds=2.0, prefix=prefix
    )


async def a_device(session: AsyncSession, party: Party, platform: DevicePlatform) -> Device:
    device = Device(
        user_id=party.id,
        expo_push_token=f"ExponentPushToken[live-{uuid.uuid4().hex[:12]}]",
        platform=platform,
        last_seen_at=T0,
    )
    session.add(device)
    await session.flush()
    return device


async def an_activity(session: AsyncSession, job: Job, device: Device, token: str = TOKEN) -> None:
    session.add(LiveActivityToken(job_id=job.id, device_id=device.id, token=token))
    await session.flush()


def service(
    session: AsyncSession, live: FakeLive, guard: RedisLiveUpdateGuard, sender: RecordingSender
) -> LiveUpdateService:
    return LiveUpdateService(session, live, guard, sender, DeviceService(session, 10))


# When: once per stage change, an ETA change at most every interval


async def test_worker_sends_on_stage_change_not_every_tick(
    db_session: AsyncSession, world: JobWorld, guard: RedisLiveUpdateGuard
) -> None:
    job = await make_job(db_session, world, JobStatus.ON_THE_WAY)
    android = await a_device(db_session, world.customer, DevicePlatform.ANDROID)
    live, sender = FakeLive(), RecordingSender()
    updates = service(db_session, live, guard, sender)

    async def tick(stage: LiveStage, eta: int | None, seconds: int) -> None:
        live.views[job.id] = view(stage, eta, T0 + timedelta(seconds=seconds))
        await updates.update(job.id)

    await tick(LiveStage.ON_THE_WAY, 600, 0)  # the first: sent
    await tick(LiveStage.ON_THE_WAY, 590, 30)  # same minute (9): not sent
    await tick(LiveStage.ON_THE_WAY, 530, 60)  # minute 8, but 60 s < 90 s: not sent
    await tick(LiveStage.ON_THE_WAY, 500, 90)  # minute 8, 90 s on: sent
    await tick(LiveStage.ON_THE_WAY, 490, 100)  # same minute: not sent
    await tick(LiveStage.ARRIVED, None, 105)  # a stage change: sent at once
    await tick(LiveStage.ARRIVED, None, 300)  # nothing new: not sent
    await tick(LiveStage.WORKING, None, 310)  # sent

    assert [(update.stage, update.eta_seconds) for update, _ in sender.sent] == [
        ("on_the_way", 600),
        ("on_the_way", 500),
        ("arrived", None),
        ("working", None),
    ]
    assert all(targets.android_tokens == (android.expo_push_token,) for _, targets in sender.sent)


async def test_live_update_skipped_after_confirm(
    db_session: AsyncSession, world: JobWorld, guard: RedisLiveUpdateGuard
) -> None:
    """A job no longer under way gets nothing, and its Live Activity tokens go."""
    job = await make_job(db_session, world, JobStatus.CONFIRMED)
    iphone = await a_device(db_session, world.customer, DevicePlatform.IOS)
    await an_activity(db_session, job, iphone)
    live, sender = FakeLive(), RecordingSender()
    live.views[job.id] = None  # what JobLiveService.current says of a confirmed job

    await service(db_session, live, guard, sender).update(job.id)

    assert sender.sent == []
    tokens = await db_session.scalars(
        select(LiveActivityToken.id).where(LiveActivityToken.job_id == job.id)
    )
    assert list(tokens) == []


# To whom: the job's customer only


async def test_targets_are_the_customers_own_devices(
    db_session: AsyncSession, world: JobWorld, guard: RedisLiveUpdateGuard
) -> None:
    """The activities of iPhones still the customer's, and their Android devices: never a
    phone that moved to another account, never the pro's."""
    job = await make_job(db_session, world, JobStatus.ON_THE_WAY)
    iphone = await a_device(db_session, world.customer, DevicePlatform.IOS)
    moved = await a_device(db_session, world.customer, DevicePlatform.IOS)
    android = await a_device(db_session, world.customer, DevicePlatform.ANDROID)
    pros_android = await a_device(db_session, world.pro, DevicePlatform.ANDROID)
    await an_activity(db_session, job, iphone, TOKEN)
    await an_activity(db_session, job, moved, "ff" * 32)
    moved.user_id = world.other_customer.id  # the phone changed hands since
    await db_session.flush()
    live, sender = FakeLive(), RecordingSender()
    live.views[job.id] = view(LiveStage.ON_THE_WAY, 300)

    await service(db_session, live, guard, sender).update(job.id)

    [(_, targets)] = sender.sent
    assert targets.activity_tokens == (TOKEN,)
    assert targets.android_tokens == (android.expo_push_token,)
    assert pros_android.expo_push_token not in targets.android_tokens


async def test_no_target_no_send_but_the_change_is_recorded(
    db_session: AsyncSession, world: JobWorld, guard: RedisLiveUpdateGuard
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    live, sender = FakeLive(), RecordingSender()
    live.views[job.id] = view(LiveStage.WORKING)

    await service(db_session, live, guard, sender).update(job.id)

    assert sender.sent == []


# What goes out


def test_live_update_payload_has_no_personal_data() -> None:
    update = LiveUpdate(
        job_id=uuid.uuid4(),
        job_public_code="JF-000777",
        stage="on_the_way",
        eta_seconds=480,
        distance_meters=3200,
        progress=0.3,
        updated_at=T0,
    )
    payloads = json.dumps(update.as_data()) + json.dumps(update.as_content_state())

    for needle in (
        CUSTOMER_EMAIL,
        CUSTOMER_FIRST,
        CUSTOMER_LAST,
        CUSTOMER_PHONE,
        PRO_EMAIL,
        PRO_PHONE,
        "María",
        LINE1,
        CODE,
        "cents",
        "lat",
        "lng",
    ):
        assert needle not in payloads, needle
    assert set(update.as_data()) == {
        "type",
        "job_id",
        "job_public_code",
        "stage",
        "eta_seconds",
        "distance_meters",
        "progress",
        "updated_at",
    }
    assert update.as_data()["eta_seconds"] == "480"


async def test_android_gets_a_data_only_message_and_apns_is_not_configured(
    caplog: pytest.LogCaptureFixture,
) -> None:
    seen: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"data": [{"status": "ok", "id": "ticket-1"}]})

    expo = ExpoPushSender(
        access_token=None, timeout_seconds=2.0, transport=httpx.MockTransport(handler)
    )
    sender = PushLiveUpdateSender(ApnsLiveActivitySender(), ExpoAndroidLiveSender(expo))
    update = LiveUpdate(
        job_id=uuid.uuid4(),
        job_public_code="JF-000777",
        stage="arrived",
        eta_seconds=None,
        distance_meters=None,
        progress=0.5,
        updated_at=T0,
    )

    with caplog.at_level(logging.INFO):
        await sender.send(
            update,
            LiveTargets(activity_tokens=(TOKEN,), android_tokens=("ExponentPushToken[a1]",)),
        )

    [[message]] = seen
    # No title, body or sound: no alert, the app makes the ongoing notification.
    assert set(message) == {"to", "data", "priority", "_contentAvailable"}
    assert message["data"]["stage"] == "arrived"
    assert message["data"]["eta_seconds"] == ""
    assert "live_update_apns_not_configured" in caplog.messages
    output = "\n".join(str(record.__dict__) for record in caplog.records)
    assert TOKEN not in output
    assert "ExponentPushToken[a1]" not in output


# The kick after a stage change


async def test_a_stage_change_kicks_one_update_per_stage() -> None:
    queue = RecordingQueue()
    job_id = uuid.uuid4()

    await kick_live_update(queue, job_id, LiveStage.ON_THE_WAY, timeout_seconds=1.0)
    await kick_live_update(queue, job_id, LiveStage.ON_THE_WAY, timeout_seconds=1.0)
    await kick_live_update(queue, job_id, LiveStage.ARRIVED, timeout_seconds=1.0)

    assert queue.jobs == {
        f"live-update:{job_id}:on_the_way": ("send_live_update", (str(job_id),)),
        f"live-update:{job_id}:arrived": ("send_live_update", (str(job_id),)),
    }


async def test_the_jobs_own_view_for_the_worker(db_session: AsyncSession, world: JobWorld) -> None:
    """JobLiveService.current, with no caller: the view of a job under way, None otherwise."""
    settings = make_settings()
    store = InMemoryJobLocationStore()
    routes = JobRouteService(
        db_session,
        JobRouteConfig.from_settings(settings),
        store,
        InMemoryJobRouteCache(),
        FakeMapbox(),
        lambda: T0,
    )
    live = JobLiveService(
        db_session, JobLiveConfig.from_settings(settings), store, routes, lambda: T0
    )
    working = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    confirmed = await make_job(db_session, world, JobStatus.CONFIRMED)

    seen = await live.current(working.id)

    assert seen is not None
    assert (seen.stage, seen.progress, seen.updated_at) == (LiveStage.WORKING, 0.75, T0)
    assert await live.current(confirmed.id) is None
    assert await live.current(uuid.uuid4()) is None


async def test_the_cron_drops_finished_jobs_tokens_and_updates_jobs_on_the_way(
    db_session: AsyncSession, world: JobWorld, guard: RedisLiveUpdateGuard
) -> None:
    on_the_way = await make_job(db_session, world, JobStatus.ON_THE_WAY)
    arrived = await make_job(db_session, world, JobStatus.ON_THE_WAY, checked_in_at=T0)
    working = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    cancelled = await make_job(db_session, world, JobStatus.CANCELLED)
    iphone = await a_device(db_session, world.customer, DevicePlatform.IOS)
    for job in (on_the_way, working, cancelled):
        await an_activity(db_session, job, iphone)
    live, sender = FakeLive(), RecordingSender()
    for job in (on_the_way, arrived, working):
        live.views[job.id] = view(LiveStage.ON_THE_WAY, 300)

    looked_at, dropped = await sweep_live_updates(
        db_session, service(db_session, live, guard, sender), at=T0
    )

    # Only the job still on the way is looked at; the cancelled job's token went.
    assert dropped >= 1
    assert [update.job_id for update, _ in sender.sent] == [on_the_way.id]
    assert looked_at >= 1
    kept = set(await db_session.scalars(select(LiveActivityToken.job_id)))
    assert cancelled.id not in kept
    assert {on_the_way.id, working.id} <= kept


async def test_on_my_way_kicks_the_live_update(
    app: Any, db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    queue = record_pushes(app)
    job = await make_job(db_session, world, JobStatus.SCHEDULED)

    response = await db_client.post(
        f"/v1/pros/me/jobs/{job.id}/on-the-way",
        json={"eta_minutes": 20},
        headers=world.pro.headers,
    )

    assert response.status_code == 200, response.text
    assert queue.jobs[f"live-update:{job.id}:on_the_way"] == ("send_live_update", (str(job.id),))


async def test_a_context_without_the_live_updates_sends_nothing(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A context the worker's startup did not build (the demo seed runs queued tasks inline):
    the job and the cron log and return."""
    with caplog.at_level(logging.INFO):
        await send_live_update({}, str(uuid.uuid4()))
        await send_live_updates({})

    assert caplog.messages.count("live_updates_not_configured") == 2


# The guard's rules (#631 round 1)


class FailingGuard:
    def __init__(self, error: Exception) -> None:
        self.error = error

    async def due(
        self, job_id: uuid.UUID, stage: str, eta_minute: int | None, now: datetime
    ) -> bool:
        raise self.error


@pytest.mark.parametrize(
    "error",
    [RedisError("down"), TimeoutError(), LocationStoreRefusedError("not_ephemeral")],
    ids=["redis error", "redis timeout", "refused"],
)
async def test_a_guard_that_cannot_answer_sends_nothing(
    db_session: AsyncSession, world: JobWorld, caplog: pytest.LogCaptureFixture, error: Exception
) -> None:
    """The module's rule: without the guard's answer nothing goes out, never one send per
    run."""
    job = await make_job(db_session, world, JobStatus.ON_THE_WAY)
    await a_device(db_session, world.customer, DevicePlatform.ANDROID)
    live, sender = FakeLive(), RecordingSender()
    live.views[job.id] = view(LiveStage.ON_THE_WAY, 300)
    updates = LiveUpdateService(
        db_session, live, FailingGuard(error), sender, DeviceService(db_session, 10)
    )

    with caplog.at_level(logging.INFO):
        await updates.update(job.id)

    assert sender.sent == []
    assert {"live_update_guard_refused", "live_update_guard_unavailable"} & set(caplog.messages)


async def test_the_eta_counts_in_whole_minutes(
    db_session: AsyncSession, world: JobWorld, guard: RedisLiveUpdateGuard
) -> None:
    """Past the interval, an ETA in the same minute is no change: nothing goes out."""
    job = await make_job(db_session, world, JobStatus.ON_THE_WAY)
    await a_device(db_session, world.customer, DevicePlatform.ANDROID)
    live, sender = FakeLive(), RecordingSender()
    updates = service(db_session, live, guard, sender)

    live.views[job.id] = view(LiveStage.ON_THE_WAY, 600, T0)  # minute 10: sent
    await updates.update(job.id)
    live.views[job.id] = view(LiveStage.ON_THE_WAY, 601, T0 + timedelta(seconds=INTERVAL + 10))
    await updates.update(job.id)  # minute 10 again, the interval passed: not sent

    assert [update.eta_seconds for update, _ in sender.sent] == [600]


def test_every_stage_has_its_place() -> None:
    assert list(STAGE_RANK) == list(LiveStage)
    assert list(STAGE_RANK.values()) == list(range(len(LiveStage)))


class SlowLive(FakeLive):
    """A view that takes its time (the route from Mapbox): `current` waits for `release`."""

    def __init__(self, stale: JobLiveOut) -> None:
        super().__init__()
        self.stale = stale
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def current(self, job_id: uuid.UUID) -> JobLiveOut | None:
        self.entered.set()
        await self.release.wait()
        return self.stale


async def test_a_slow_run_never_sends_a_stage_behind_the_one_sent(
    db_session: AsyncSession, world: JobWorld, guard: RedisLiveUpdateGuard
) -> None:
    """#631 round 1, B2. The cron's run reads the job on the way and waits for its route; the
    pro checks in meanwhile and "arrived" goes out; then the route answers. Its view is made
    last, so its time is the latest, but its stage is behind: it is never sent."""
    job = await make_job(db_session, world, JobStatus.ON_THE_WAY)
    await a_device(db_session, world.customer, DevicePlatform.ANDROID)
    sender = RecordingSender()
    fast = FakeLive()
    fast.views[job.id] = view(LiveStage.ON_THE_WAY, 300, T0)
    await service(db_session, fast, guard, sender).update(job.id)  # On my way: sent
    slow = SlowLive(view(LiveStage.ON_THE_WAY, 120, T0 + timedelta(seconds=INTERVAL + 2)))

    cron = asyncio.create_task(service(db_session, slow, guard, sender).update(job.id))
    async with asyncio.timeout(5):
        await slow.entered.wait()
    fast.views[job.id] = view(LiveStage.ARRIVED, None, T0 + timedelta(seconds=INTERVAL + 1))
    await service(db_session, fast, guard, sender).update(job.id)  # the check-in: sent
    slow.release.set()
    async with asyncio.timeout(5):
        await cron

    assert [update.stage for update, _ in sender.sent] == ["on_the_way", "arrived"]


async def test_with_the_defaults_each_cron_minute_sends_a_changed_eta(
    db_session: AsyncSession, world: JobWorld, redis: Redis, prefix: str
) -> None:
    """#631 round 1, B3. With the default interval, cron runs a minute apart each send a
    changed ETA minute, wherever in its minute a job's view is ready (a route, the jobs before
    it): a run is timed by its minute. A second run for the same minute sends nothing."""
    settings = make_settings()
    guard = RedisLiveUpdateGuard(
        redis,
        None,
        interval_seconds=settings.live_update_interval_seconds,
        ttl_seconds=600,
        timeout_seconds=2.0,
        prefix=prefix,
    )
    job = await make_job(db_session, world, JobStatus.ON_THE_WAY)
    await a_device(db_session, world.customer, DevicePlatform.ANDROID)
    live, sender = FakeLive(), RecordingSender()
    updates = service(db_session, live, guard, sender)

    # (the run's minute, when the view was ready, the ETA): the Gatekeeper's cases.
    for minute, ready, eta in (
        (0, 1.6, 600),  # minute 10
        (1, 60.7, 530),  # minute 8: 59.1 s after the last view, but a minute after its run
        (2, 122.3, 470),  # minute 7
        (3, 181.1, 410),  # minute 6
        (3, 181.9, 350),  # the same run's minute again: not sent
    ):
        live.views[job.id] = view(LiveStage.ON_THE_WAY, eta, T0 + timedelta(seconds=ready))
        await sweep_live_updates(db_session, updates, at=T0 + timedelta(minutes=minute))

    assert [update.eta_seconds for update, _ in sender.sent] == [600, 530, 470, 410]


async def test_expo_unavailable_is_logged_and_never_raised(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An Android send that cannot reach Expo ends quietly: the cron's run goes on with the
    jobs after it."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("unreachable", request=request)

    expo = ExpoPushSender(
        access_token=None, timeout_seconds=2.0, transport=httpx.MockTransport(handler)
    )
    update = LiveUpdate(
        job_id=uuid.uuid4(),
        job_public_code="JF-000777",
        stage="on_the_way",
        eta_seconds=480,
        distance_meters=3200,
        progress=0.3,
        updated_at=T0,
    )

    with caplog.at_level(logging.INFO):
        await ExpoAndroidLiveSender(expo).send(update, ["ExponentPushToken[a1]"])

    assert "live_update_android_unavailable" in caplog.messages


# The worker's own job and cron, as app.worker wires them (#631 round 1, B4)


def expo_recording(messages: list[dict[str, Any]]) -> ExpoPushSender:
    def handler(request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        messages.extend(sent)
        tickets = [{"status": "ok", "id": f"ticket-{n}"} for n in range(len(sent))]
        return httpx.Response(200, json={"data": tickets})

    return ExpoPushSender(
        access_token=None, timeout_seconds=2.0, transport=httpx.MockTransport(handler)
    )


def worker_context(
    settings: Settings,
    session: AsyncSession,
    redis: Redis | None,
    push: ExpoPushSender,
    **overrides: Any,
) -> dict[str, Any]:
    """The context app.worker's startup makes (live_update_deps), on the test's session."""
    sessions = cast(async_sessionmaker[AsyncSession], sessions_of(session))
    deps = live_update_deps(settings, sessions, redis, push)
    return {"live_updates": replace(deps, **overrides)}


async def test_the_worker_job_and_cron_send_a_real_jobs_updates(
    db_session: AsyncSession, world: JobWorld, redis: Redis
) -> None:
    """From a real job, its position in the positions' Redis and its route, to what Expo gets:
    the kicked job sends the stage, each cron minute a changed ETA minute, and nothing of
    either person, the address or the arrival code goes out."""
    settings = make_settings()
    messages: list[dict[str, Any]] = []
    mapbox = FakeMapbox()
    now = [T0]
    ctx = worker_context(
        settings,
        db_session,
        redis,
        expo_recording(messages),
        provider=mapbox,
        clock=lambda: now[0],
    )
    deps: LiveUpdateDeps = ctx["live_updates"]
    job = await on_the_way_job(db_session, world)
    await locate(db_session, world)
    android = await a_device(db_session, world.customer, DevicePlatform.ANDROID)
    store = location_store_of(deps.backend, settings)

    async def ping(seconds: float, duration: float) -> None:
        """The clock, the pro's latest position, and what Mapbox would answer now."""
        now[0] = T0 + timedelta(seconds=seconds)
        mapbox.found = replace(drive(), duration_s=duration)
        await plant(store, job.id, now[0])

    try:
        await ping(-29.6, 1260.4)  # On my way, 11:59:30.4
        await send_live_update(ctx, str(job.id))  # the stage and minute 21: sent
        await ping(0.6, 1230.0)
        await send_live_updates(ctx)  # 30 s on: not yet
        await ping(61.9, 1169.0)
        await send_live_updates(ctx)  # minute 19: sent
        await ping(120.3, 1110.0)
        await send_live_updates(ctx)  # minute 18, 58.4 s later but the next minute: sent
    finally:
        keys = [key async for key in redis.scan_iter(match=f"{KEY_PREFIX}*{job.id}*")]
        if keys:
            await redis.delete(*keys)

    sent = [(m["data"]["stage"], int(m["data"]["eta_seconds"]) // 60) for m in messages]
    assert sent == [("on_the_way", 21), ("on_the_way", 19), ("on_the_way", 18)]
    assert {message["to"] for message in messages} == {android.expo_push_token}
    assert {message["data"]["job_id"] for message in messages} == {str(job.id)}
    # The job's own ids aside (a random one could hold any four digits), nothing personal.
    shown = [
        {k: v for k, v in m["data"].items() if k not in ("job_id", "job_public_code")}
        for m in messages
    ]
    wire = json.dumps(shown)
    for needle in NEEDLES:
        assert needle not in wire, needle


async def test_without_the_positions_redis_nothing_is_sent(
    db_session: AsyncSession, world: JobWorld, caplog: pytest.LogCaptureFixture
) -> None:
    """A worker with no positions' Redis (LOCATION_REDIS_URL missing in staging or
    production): its job and its cron send nothing, and say why."""
    settings = make_settings()
    messages: list[dict[str, Any]] = []
    ctx = worker_context(settings, db_session, None, expo_recording(messages))
    job = await make_job(db_session, world, JobStatus.ON_THE_WAY)
    await a_device(db_session, world.customer, DevicePlatform.ANDROID)

    with caplog.at_level(logging.INFO):
        await send_live_update(ctx, str(job.id))
        await send_live_updates(ctx)

    assert messages == []
    assert caplog.messages.count("live_update_guard_refused") == 2
