"""The live updates (#596, PR 2b): what goes out, to whom, when, and never after the job.

The senders are fakes, or Expo on a mock transport: never the network. The guard runs in the
real Redis of REDIS_URL under a prefix of the test's own, deleted afterwards.
"""

import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

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
    LiveUpdateService,
    RedisLiveUpdateGuard,
    kick_live_update,
    sweep_live_updates,
)
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
from tests.test_job_route_api import FakeMapbox
from tests.test_pro_location_api import CODE, prefix, redis
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
        db_session, service(db_session, live, guard, sender)
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
