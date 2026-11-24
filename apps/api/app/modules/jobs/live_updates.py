"""The live updates of an ongoing job to its customer's lock screen (#596, PR 2b; Cesar
2026-11-23, the Foreman's answers 2026-11-24).

- What goes out: the live view (live.py) as a LiveUpdate (app/integrations/live_updates.py):
  no name, address, arrival code, amount or position.
- To whom: the job's customer only. The Live Activity tokens kept for the job (live_tokens.py)
  of devices still theirs (a phone can move to another account), and their Android devices.
- When: once per stage change, kicked after each step commits (On my way, the check-in, the
  start, done: `kick_live_update`), and while the pro is on the way, when the ETA in whole
  minutes changes, at most every LIVE_UPDATE_INTERVAL_SECONDS: a cron looks at every job on
  the way each minute (`send_live_updates`).
- The guard decides: one key per job in the positions' Redis (the ETA is position-derived),
  for LIVE_UPDATE_STATE_TTL_SECONDS, holding the last stage and ETA minute sent and when. One
  Lua step decides and records at once, so two runs never both send the same change. A guard
  that cannot answer sends nothing: an update is never worth a flood.
- Nothing after the job is under way: a run for a job confirmed, cancelled or otherwise past
  its stages sends nothing and deletes the job's Live Activity tokens; the cron also deletes
  the tokens of every such job.
- Best effort: an update that did not go out is not tried again; the next one replaces it.
- Logs carry the job's id, the stage and counts, never a token or the payload.
"""

import asyncio
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Protocol

from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.integrations.expo_push import ExpoPushSender
from app.integrations.live_updates import (
    ApnsLiveActivitySender,
    ExpoAndroidLiveSender,
    LiveTargets,
    LiveUpdate,
    LiveUpdateSender,
    PushLiveUpdateSender,
)
from app.integrations.mapbox import RouteProvider, provider_from_settings
from app.modules.devices.service import DeviceService
from app.modules.jobs.live import JobLiveConfig, JobLiveService
from app.modules.jobs.location import (
    KEY_PREFIX,
    LocationBackend,
    location_backend,
    location_store_of,
    utc_now,
)
from app.modules.jobs.location_guard import EphemeralRedisGuard, LocationStoreRefusedError
from app.modules.jobs.models import Job, JobStatus, LiveActivityToken
from app.modules.jobs.route import JobRouteConfig, JobRouteService, route_cache_of
from app.modules.jobs.schemas import JobLiveOut
from app.queue import JobQueue, enqueue

logger = logging.getLogger(__name__)

# The statuses a job is under way in (live.live_stage): a token of any other job is dropped.
LIVE_STATUSES: Final = (JobStatus.ON_THE_WAY, JobStatus.IN_PROGRESS, JobStatus.COMPLETED)

# Decides and records in one step. KEYS[1]: the job's guard. ARGV: the stage, the ETA minute
# ('' when unknown), now and the interval (whole seconds), the key's lifetime. 1 when the
# update is due (and recorded as sent), 0 when it is not (nothing written).
_DUE_SCRIPT: Final = """
local stored = redis.call('HMGET', KEYS[1], 'stage', 'eta', 'sent')
local due = false
if stored[1] ~= ARGV[1] then
  due = true
elseif stored[2] ~= ARGV[2] and tonumber(ARGV[3]) - tonumber(stored[3]) >= tonumber(ARGV[4]) then
  due = true
end
if due then
  redis.call('HSET', KEYS[1], 'stage', ARGV[1], 'eta', ARGV[2], 'sent', ARGV[3])
  redis.call('EXPIRE', KEYS[1], ARGV[5])
  return 1
end
return 0
"""


def guard_key(prefix: str, job_id: uuid.UUID) -> str:
    return f"{prefix}:live:{job_id}"


class LiveUpdateGuard(Protocol):
    async def due(
        self, job_id: uuid.UUID, stage: str, eta_minute: int | None, now: datetime
    ) -> bool:
        """Whether an update of this stage and ETA minute goes out now, recorded as sent when
        it does. May raise RedisError, OSError or LocationStoreRefusedError."""
        ...


class RedisLiveUpdateGuard:
    def __init__(
        self,
        redis: Redis,
        guard: EphemeralRedisGuard | None,
        *,
        interval_seconds: int,
        ttl_seconds: int,
        timeout_seconds: float,
        prefix: str = KEY_PREFIX,
    ) -> None:
        self._guard = guard
        self._interval = interval_seconds
        self._ttl = ttl_seconds
        self._timeout = timeout_seconds
        self._prefix = prefix
        self._script = redis.register_script(_DUE_SCRIPT)

    async def due(
        self, job_id: uuid.UUID, stage: str, eta_minute: int | None, now: datetime
    ) -> bool:
        async with asyncio.timeout(self._timeout):
            if self._guard is not None:
                await self._guard.require()
            answer = await self._script(
                keys=[guard_key(self._prefix, job_id)],
                args=[
                    stage,
                    "" if eta_minute is None else str(eta_minute),
                    int(now.timestamp()),
                    self._interval,
                    self._ttl,
                ],
            )
        return bool(answer)


class LiveViews(Protocol):
    async def current(self, job_id: uuid.UUID) -> JobLiveOut | None:
        """The live view of a job under way; None otherwise (JobLiveService.current)."""
        ...


class LiveUpdateService:
    def __init__(
        self,
        session: AsyncSession,
        live: LiveViews,
        guard: LiveUpdateGuard,
        sender: LiveUpdateSender,
        devices: DeviceService,
    ) -> None:
        self._session = session
        self._live = live
        self._guard = guard
        self._sender = sender
        self._devices = devices

    async def update(self, job_id: uuid.UUID) -> None:
        """Sends the job's update when it is due; for a job not under way, sends nothing and
        drops its Live Activity tokens."""
        ids = {"job_id": str(job_id)}
        view = await self._live.current(job_id)
        if view is None:
            await self._forget(job_id)
            return
        eta_minute = None if view.eta_seconds is None else view.eta_seconds // 60
        try:
            due = await self._guard.due(job_id, view.stage.value, eta_minute, view.updated_at)
        except LocationStoreRefusedError as refused:
            logger.error("live_update_guard_refused", extra={**ids, "reason": refused.reason})
            return
        except (RedisError, OSError):  # OSError includes TimeoutError
            logger.error("live_update_guard_unavailable", extra=ids)
            return
        if not due:
            return
        targets = await self._targets(job_id)
        await self._session.commit()  # nothing is held while the update goes out
        if targets.empty:
            return
        update = LiveUpdate(
            job_id=job_id,
            job_public_code=view.job_public_code,
            stage=view.stage.value,
            eta_seconds=view.eta_seconds,
            distance_meters=view.distance_meters,
            progress=view.progress,
            updated_at=view.updated_at,
        )
        await self._sender.send(update, targets)
        logger.info(
            "live_update_sent",
            extra={
                **ids,
                "stage": view.stage.value,
                "activities": len(targets.activity_tokens),
                "android": len(targets.android_tokens),
            },
        )

    async def _targets(self, job_id: uuid.UUID) -> LiveTargets:
        customer_id = await self._session.scalar(select(Job.customer_id).where(Job.id == job_id))
        if customer_id is None:
            return LiveTargets(activity_tokens=(), android_tokens=())
        iphones = {target.device_id for target in await self._devices.iphones_of(customer_id)}
        tokens = (
            await self._session.scalars(
                select(LiveActivityToken.token)
                .where(LiveActivityToken.job_id == job_id)
                .where(LiveActivityToken.device_id.in_(iphones))
                .order_by(LiveActivityToken.device_id)
            )
            if iphones
            else None
        )
        android = await self._devices.androids_of(customer_id)
        return LiveTargets(
            activity_tokens=() if tokens is None else tuple(tokens),
            android_tokens=tuple(target.expo_push_token for target in android),
        )

    async def _forget(self, job_id: uuid.UUID) -> None:
        result = await self._session.execute(
            delete(LiveActivityToken).where(LiveActivityToken.job_id == job_id)
        )
        await self._session.commit()
        count = result.rowcount  # type: ignore[attr-defined]  # CursorResult of a DELETE
        if count:
            logger.info(
                "live_activity_tokens_dropped", extra={"job_id": str(job_id), "count": count}
            )


async def kick_live_update(
    queue: JobQueue, job_id: uuid.UUID, stage: str, *, timeout_seconds: float
) -> None:
    """Queues the update of a stage the job just reached, after the step committed: one job per
    job and stage. A queue that fails is logged and never fails the step; the stage shows on
    the next update or when the app reads the view."""
    try:
        await enqueue(
            queue,
            "send_live_update",
            str(job_id),
            job_id=f"live-update:{job_id}:{stage}",
            timeout_seconds=timeout_seconds,
        )
    except (TimeoutError, RedisError, OSError):
        logger.error("live_update_enqueue_failed", extra={"job_id": str(job_id), "stage": stage})


# The worker side.


@dataclass(frozen=True)
class LiveUpdateDeps:
    settings: Settings
    sessions: async_sessionmaker[AsyncSession]
    backend: LocationBackend | None
    provider: RouteProvider
    sender: LiveUpdateSender
    clock: Callable[[], datetime] = utc_now

    @classmethod
    def from_context(cls, ctx: dict[str, Any]) -> "LiveUpdateDeps | None":
        """None in a context the worker's startup did not build (the demo seed runs queued
        tasks inline): the live updates then send nothing."""
        deps: LiveUpdateDeps | None = ctx.get("live_updates")
        return deps


def live_update_deps(
    settings: Settings,
    sessions: async_sessionmaker[AsyncSession],
    queue_redis: Redis | None,
    push_sender: ExpoPushSender,
) -> LiveUpdateDeps:
    """What the worker's live updates use, built once at its startup (app.worker). Without
    ARQ's Redis (only a test's bare context) there are no positions, and nothing is sent."""
    return LiveUpdateDeps(
        settings=settings,
        sessions=sessions,
        backend=None if queue_redis is None else location_backend(settings, queue_redis),
        provider=provider_from_settings(settings),
        sender=PushLiveUpdateSender(ApnsLiveActivitySender(), ExpoAndroidLiveSender(push_sender)),
    )


def _service(deps: LiveUpdateDeps, session: AsyncSession) -> LiveUpdateService:
    settings = deps.settings
    store = location_store_of(deps.backend, settings)
    routes = JobRouteService(
        session,
        JobRouteConfig.from_settings(settings),
        store,
        route_cache_of(deps.backend, settings),
        deps.provider,
        deps.clock,
    )
    live = JobLiveService(session, JobLiveConfig.from_settings(settings), store, routes, deps.clock)
    guard: LiveUpdateGuard = (
        _NoGuard()
        if deps.backend is None
        else RedisLiveUpdateGuard(
            deps.backend.redis,
            deps.backend.guard,
            interval_seconds=settings.live_update_interval_seconds,
            ttl_seconds=settings.live_update_state_ttl_seconds,
            timeout_seconds=settings.pro_location_timeout_seconds,
        )
    )
    devices = DeviceService(session, settings.push_max_devices_per_user)
    return LiveUpdateService(session, live, guard, deps.sender, devices)


class _NoGuard:
    """Without the positions' Redis (LOCATION_REDIS_URL missing where it is required) nothing
    can be remembered, so nothing is sent."""

    async def due(
        self, job_id: uuid.UUID, stage: str, eta_minute: int | None, now: datetime
    ) -> bool:
        raise LocationStoreRefusedError("not_configured")


async def send_live_update(ctx: dict[str, Any], job_id: str) -> None:
    """One job's update, kicked by a stage change."""
    deps = LiveUpdateDeps.from_context(ctx)
    if deps is None:
        logger.info("live_updates_not_configured", extra={"job_id": job_id})
        return
    async with deps.sessions() as session:
        await _service(deps, session).update(uuid.UUID(job_id))


async def send_live_updates(ctx: dict[str, Any]) -> None:
    """The cron, every minute (app.worker)."""
    deps = LiveUpdateDeps.from_context(ctx)
    if deps is None:
        logger.info("live_updates_not_configured")
        return
    async with deps.sessions() as session:
        jobs, dropped = await sweep_live_updates(session, _service(deps, session))
    logger.info("live_updates_swept", extra={"jobs": jobs, "tokens_dropped": dropped})


async def sweep_live_updates(session: AsyncSession, service: LiveUpdateService) -> tuple[int, int]:
    """Drops the Live Activity tokens of every job no longer under way, then gives each job on
    the way (the stage whose ETA moves) its update when due: (jobs looked at, tokens dropped)."""
    dropped = await session.execute(
        delete(LiveActivityToken).where(
            LiveActivityToken.job_id.in_(select(Job.id).where(Job.status.not_in(LIVE_STATUSES)))
        )
    )
    tracked = list(
        await session.scalars(
            select(Job.id).where(Job.status == JobStatus.ON_THE_WAY, Job.checked_in_at.is_(None))
        )
    )
    await session.commit()
    count: int = dropped.rowcount  # type: ignore[attr-defined]  # CursorResult of a DELETE
    for job_id in tracked:
        await service.update(job_id)
    return len(tracked), count
