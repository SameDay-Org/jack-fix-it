"""The live job view (#596; Cesar 2026-11-23): one compact view of an ongoing job for the lock
screen (an iPhone Live Activity, an Android ongoing notification), the same for its customer
and its pro.

- Who reads it: the job's customer and the pro it is assigned to. Anyone else gets 404, as for
  an unknown id, through one statement scoped to the caller (JobRepository.get_with_pro_user).
- When: while the job is under way, from On my way to the customer's confirmation. Before
  that, and after it (or cancelled, refunded, disputed), 409 job_not_live.
- What it carries: the request's code (what lock screens already show), the stage, the ETA and
  the road left while on the way, a progress, and when it was put together. Never a name, an
  address, the arrival code, an amount or the pro's position: the customer learns how far the
  pro is, not where.
- The ETA comes from the pro's route (#351, route.py, with its cache and its one Mapbox call
  per job at a time), less the time since that route was computed, and never below 0. A
  position older than LIVE_POSITION_MAX_AGE_SECONDS gives no ETA and no distance, nor does a
  route that cannot be had (the route logs its own failures): the view answers all the same.
- Progress: on the way, half the share of the trip's road already driven, measured against
  the first route computed after On my way (kept with the position, location.py), and 0 while
  the road left is unknown; arrived 0.5, working 0.75, done 1.
- Nothing is held over Redis or Mapbox: the job is read, the transaction ends, then the
  position and the route are asked for.
"""

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final

from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import NotFoundError
from app.modules.jobs.errors import (
    JobNotLiveError,
    ProLocationUnavailableError,
    RouteUnavailableError,
)
from app.modules.jobs.location import JobLocationStore, utc_now
from app.modules.jobs.location_guard import LocationStoreRefusedError
from app.modules.jobs.models import Job, JobStatus
from app.modules.jobs.repository import JobRepository
from app.modules.jobs.route import JobRouteService
from app.modules.jobs.schemas import JobLiveOut, LiveStage
from app.modules.pros.service import ProService
from app.modules.requests.service import CustomerRequestReader
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)

# The progress of each stage after the trip; on the way runs from 0 to ON_THE_WAY_SHARE.
STAGE_PROGRESS: Final = {
    LiveStage.ARRIVED: 0.5,
    LiveStage.WORKING: 0.75,
    LiveStage.DONE_WAITING_CONFIRM: 1.0,
}
ON_THE_WAY_SHARE: Final = 0.5


@dataclass(frozen=True)
class JobLiveConfig:
    # A position older than this gives no ETA and no distance.
    position_max_age: timedelta

    @classmethod
    def from_settings(cls, settings: Settings) -> "JobLiveConfig":
        return cls(position_max_age=timedelta(seconds=settings.live_position_max_age_seconds))


@dataclass(frozen=True)
class _Trip:
    eta_seconds: int | None
    distance_meters: int | None
    progress: float


_UNKNOWN_TRIP: Final = _Trip(eta_seconds=None, distance_meters=None, progress=0.0)


def live_stage(job: Job) -> LiveStage | None:
    """The job's stage on the lock screen; None when it is not under way."""
    if job.status is JobStatus.ON_THE_WAY:
        return LiveStage.ON_THE_WAY if job.checked_in_at is None else LiveStage.ARRIVED
    if job.status is JobStatus.IN_PROGRESS:
        return LiveStage.WORKING
    if job.status is JobStatus.COMPLETED:
        return LiveStage.DONE_WAITING_CONFIRM
    return None


def trip_progress(left_m: float, first_m: float | None) -> float:
    """On the way: ON_THE_WAY_SHARE times the share of the first route's road driven since,
    between 0 and ON_THE_WAY_SHARE; 0 without a first route."""
    if first_m is None or first_m <= 0:
        return 0.0
    driven = min(1.0, max(0.0, 1.0 - left_m / first_m))
    return round(ON_THE_WAY_SHARE * driven, 3)


class JobLiveService:
    def __init__(
        self,
        session: AsyncSession,
        config: JobLiveConfig,
        store: JobLocationStore,
        routes: JobRouteService,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._session = session
        self._config = config
        self._store = store
        self._routes = routes
        self._clock = clock
        self._jobs = JobRepository(session)
        self._requests = CustomerRequestReader(session)

    async def view(self, user: UserAccount, job_id: uuid.UUID) -> JobLiveOut:
        found = await self._jobs.get_with_pro_user(
            job_id, ProService.users(), participant=user.id, lock=False
        )
        if found is None:
            raise NotFoundError
        job, _ = found
        stage = live_stage(job)
        if stage is None:
            raise JobNotLiveError
        request_id = job.request_id
        code = await self._requests.public_code(request_id)
        # Ends the read transaction: no pooled connection waits on Redis or on Mapbox.
        await self._session.commit()
        if stage is LiveStage.ON_THE_WAY:
            trip = await self._trip(job_id, request_id)
        else:
            trip = _Trip(eta_seconds=None, distance_meters=None, progress=STAGE_PROGRESS[stage])
        return JobLiveOut(
            job_public_code=code,
            stage=stage,
            eta_seconds=trip.eta_seconds,
            distance_meters=trip.distance_meters,
            progress=trip.progress,
            updated_at=self._clock(),
        )

    async def _trip(self, job_id: uuid.UUID, request_id: uuid.UUID) -> _Trip:
        """How far the pro is: unknown, and logged, when the store cannot answer."""
        ids = {"job_id": str(job_id)}
        try:
            position = await self._store.get(job_id)
            first_m = None if position is None else await self._store.trip_distance(job_id)
        except LocationStoreRefusedError as refused:
            logger.error("job_live_store_refused", extra={**ids, "reason": refused.reason})
            return _UNKNOWN_TRIP
        except (RedisError, OSError):  # OSError includes TimeoutError
            logger.error("job_live_position_unavailable", extra=ids)
            return _UNKNOWN_TRIP
        if position is None or self._clock() - position.updated_at > self._config.position_max_age:
            return _UNKNOWN_TRIP
        try:
            answer = await self._routes.current(job_id, request_id)
        except (RouteUnavailableError, ProLocationUnavailableError):
            return _UNKNOWN_TRIP  # the route logged what failed
        route = answer.route
        if route is None:
            return _UNKNOWN_TRIP
        elapsed = max(0.0, (self._clock() - route.computed_at).total_seconds())
        return _Trip(
            eta_seconds=max(0, round(route.duration_s - elapsed)),
            distance_meters=max(0, round(route.distance_m)),
            progress=trip_progress(route.distance_m, first_m),
        )
