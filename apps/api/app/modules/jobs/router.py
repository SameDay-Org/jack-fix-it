import uuid
from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.integrations.storage import StorageProvider, get_storage_provider
from app.middleware import NoStoreRoute
from app.modules.auth.permissions import CustomerUser, ProUser
from app.modules.jobs.errors import ATTEMPTS_REMAINING_HEADER
from app.modules.jobs.execution import JobExecutionConfig, JobExecutionService
from app.modules.jobs.location import (
    JobLocationStore,
    ProLocationConfig,
    ProLocationService,
    get_job_location_store,
    get_location_clock,
)
from app.modules.jobs.schemas import (
    CheckInIn,
    CustomerJob,
    JobPhotosIn,
    OnTheWayIn,
    ProJob,
    ProJobPage,
    ProLocationIn,
    ProLocationOut,
)
from app.queue import JobQueue, get_job_queue
from app.rate_limit import RateLimiter, enforce_limit, get_rate_limiter

# The customer's side: the job of their own request (#63).
customer_router = APIRouter(prefix="/requests", tags=["jobs"])
# The pro's side: their own jobs and the steps they take on them (#63).
router = APIRouter(prefix="/pros/me/jobs", tags=["jobs"])
# The pro's live position while on the way (#350): the pro's app writes it, the customer's
# reads it. No HTTP cache may keep a response of these routes: a stored position would
# outlive its expiry and its delete.
location_router = APIRouter(
    prefix="/jobs/{job_id}/pro-location", tags=["jobs"], route_class=NoStoreRoute
)

_UNAUTHORIZED = {"model": ErrorResponse, "description": "invalid_token: missing or expired."}


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_job_execution_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    storage: Annotated[StorageProvider, Depends(get_storage_provider)],
    locations: Annotated[JobLocationStore, Depends(get_job_location_store)],
) -> JobExecutionService:
    # The storage is reached only when a job has photos to sign; the location store only when
    # the pro checks in or the job leaves on_the_way.
    return JobExecutionService(
        session, JobExecutionConfig.from_settings(settings), storage, locations
    )


Jobs = Annotated[JobExecutionService, Depends(get_job_execution_service)]


def get_pro_location_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    store: Annotated[JobLocationStore, Depends(get_job_location_store)],
    clock: Annotated[Callable[[], datetime], Depends(get_location_clock)],
) -> ProLocationService:
    return ProLocationService(session, ProLocationConfig.from_settings(settings), store, clock)


Locations = Annotated[ProLocationService, Depends(get_pro_location_service)]


async def limit_pro_pings(
    user: ProUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """PRO_LOCATION_RATE_LIMIT positions per pro per PRO_LOCATION_RATE_WINDOW_SECONDS, over
    all their jobs, counted before the position or the job is looked at (a body that is not
    JSON at all is refused first, as on every route)."""
    await enforce_limit(
        limiter,
        "pro_location",
        str(user.id),
        limit=settings.pro_location_rate_limit,
        window_seconds=settings.pro_location_rate_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


_PRO_JOB_ERRORS: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
    status.HTTP_403_FORBIDDEN: _error("forbidden: only pros have jobs to work on."),
    status.HTTP_404_NOT_FOUND: _error("not_found: no job of the caller with this id."),
}


@customer_router.get(
    "/{request_id}/job",
    response_model=CustomerJob,
    summary="Follow the job of one of my service requests",
    responses={
        status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN: _error("forbidden: only customers have service requests."),
        status.HTTP_404_NOT_FOUND: _error(
            "not_found: no request of the caller with this id, or no job on it yet (the job "
            "starts once the payment succeeds)."
        ),
    },
)
async def get_request_job(request_id: uuid.UUID, user: CustomerUser, jobs: Jobs) -> CustomerJob:
    """The job once paid: its status, the scheduled start, the pro's public card, the ETA once
    the pro is on the way, the arrival code to give the pro (only while they are on the way and
    have not checked in), the history, the pro's before and after photos (their privacy-safe
    copies) and what the customer paid."""
    return await jobs.customer_job(user, request_id)


@customer_router.post(
    "/{request_id}/job/confirm",
    response_model=CustomerJob,
    summary="Confirm the job of one of my service requests is done",
    responses={
        status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN: _error("forbidden: only customers have service requests."),
        status.HTTP_404_NOT_FOUND: _error(
            "not_found: no request of the caller with this id, or no job on it yet."
        ),
        status.HTTP_409_CONFLICT: _error(
            "job_not_completed: the pro has not marked the job done, or it is past confirmation "
            "(a problem reported, paid out, refunded or cancelled)."
        ),
    },
)
async def confirm_request_job(
    request_id: uuid.UUID,
    user: CustomerUser,
    jobs: Jobs,
    queue: Annotated[JobQueue, Depends(get_job_queue)],
) -> CustomerJob:
    """Completed -> confirmed: the customer agrees the work is done, before confirm_by (after it,
    the system confirms on its own unless a problem is open). Again once confirmed: the job
    unchanged. The pro hears once the job is confirmed."""
    return await jobs.confirm(user, request_id, queue)


@router.get(
    "",
    response_model=ProJobPage,
    summary="List my jobs",
    responses={
        status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN: _error("forbidden: only pros have jobs to work on."),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error("validation_error: a bad cursor or limit."),
    },
)
async def list_my_jobs(
    user: ProUser,
    jobs: Jobs,
    active: Annotated[
        bool, Query(description="Only jobs still to do: scheduled, on the way or working.")
    ] = False,
    limit: Annotated[int | None, Query(gt=0, description="Page size; capped.")] = None,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
) -> ProJobPage:
    """The caller's jobs, newest scheduled start first."""
    return await jobs.pro_jobs(user, active=active, limit=limit, cursor=cursor)


@router.get(
    "/{job_id}", response_model=ProJob, summary="See one of my jobs", responses=_PRO_JOB_ERRORS
)
async def get_my_job(job_id: uuid.UUID, user: ProUser, jobs: Jobs) -> ProJob:
    """The job with the whole address and the customer's first name. Never the arrival code or
    a contact."""
    return await jobs.pro_job(user, job_id)


@router.post(
    "/{job_id}/on-the-way",
    response_model=ProJob,
    summary="Tell the customer I am on my way",
    responses={
        **_PRO_JOB_ERRORS,
        status.HTTP_409_CONFLICT: _error("invalid_transition: the job is not scheduled."),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: eta_minutes not an integer from 5 to 240."
        ),
    },
)
async def mark_on_the_way(
    job_id: uuid.UUID,
    data: OnTheWayIn,
    user: ProUser,
    jobs: Jobs,
    queue: Annotated[JobQueue, Depends(get_job_queue)],
) -> ProJob:
    """Scheduled -> on the way, with an ETA the customer sees; the customer gets an arrival
    code to give the pro on arrival. Again while on the way: only the ETA changes (the code
    stays)."""
    return await jobs.on_the_way(user, job_id, data.eta_minutes, queue)


@router.post(
    "/{job_id}/check-in",
    response_model=ProJob,
    summary="Check in at the job with the customer's arrival code",
    responses={
        **_PRO_JOB_ERRORS,
        status.HTTP_409_CONFLICT: _error("not_on_the_way: the job is not on the way."),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "arrival_code_invalid: the code is not right; the "
            f"{ATTEMPTS_REMAINING_HEADER} header has the tries left. validation_error: the "
            "code is not 4 digits, or lat/lng out of range."
        ),
        status.HTTP_423_LOCKED: _error(
            "arrival_code_locked: too many wrong codes; support resolves it."
        ),
    },
)
async def check_in(
    job_id: uuid.UUID,
    data: CheckInIn,
    user: ProUser,
    jobs: Jobs,
    queue: Annotated[JobQueue, Depends(get_job_queue)],
) -> ProJob:
    """Arrived: the code the customer gives the pro, and where the pro is (recorded only). Once
    checked in, calling it again answers the job unchanged."""
    return await jobs.check_in(user, job_id, data.arrival_code, data.lat, data.lng, queue)


@router.post(
    "/{job_id}/start",
    response_model=ProJob,
    summary="Start working on the job",
    responses={
        **_PRO_JOB_ERRORS,
        status.HTTP_409_CONFLICT: _error(
            "check_in_required: no check-in yet; invalid_transition: the job is past on the way."
        ),
    },
)
async def start_job(
    job_id: uuid.UUID,
    user: ProUser,
    jobs: Jobs,
    queue: Annotated[JobQueue, Depends(get_job_queue)],
) -> ProJob:
    """On the way -> working, after the check-in."""
    return await jobs.start(user, job_id, queue)


@router.post(
    "/{job_id}/photos",
    response_model=ProJob,
    status_code=status.HTTP_201_CREATED,
    summary="Add before or after photos of the work",
    responses={
        **_PRO_JOB_ERRORS,
        status.HTTP_409_CONFLICT: _error(
            "job_photo_not_allowed: before photos need the job on the way or working, after "
            "photos working; duplicate_photo: a key given twice or already attached; "
            "job_photo_limit: more photos of the kind than a job holds (a photo whose "
            "privacy-safe copy failed frees its place, a bounded number of times)."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "invalid_photo: a key that is not one of the caller's own job_photo uploads "
            "(nothing is stored); upload_expired: an upload issued too long ago, upload it "
            "again (nothing is stored); validation_error: a bad kind or no keys."
        ),
    },
)
async def add_job_photos(
    job_id: uuid.UUID,
    data: JobPhotosIn,
    user: ProUser,
    jobs: Jobs,
    queue: Annotated[JobQueue, Depends(get_job_queue)],
) -> ProJob:
    """Attaches photos the pro uploaded (POST /v1/uploads, purpose job_photo), in the order
    given. The customer sees each once its privacy-safe copy is made."""
    return await jobs.add_photos(user, job_id, data.kind, data.upload_keys, queue)


@router.post(
    "/{job_id}/complete",
    response_model=ProJob,
    summary="Mark the job done",
    responses={
        **_PRO_JOB_ERRORS,
        status.HTTP_409_CONFLICT: _error(
            "after_photos_processing: the after photos' privacy-safe copies are still being "
            "made, try again shortly; after_photos_required: no after photo the customer can "
            "see (none, or all failed: add another); invalid_transition: the job is not working."
        ),
    },
)
async def complete_job(
    job_id: uuid.UUID,
    user: ProUser,
    jobs: Jobs,
    queue: Annotated[JobQueue, Depends(get_job_queue)],
) -> ProJob:
    """Working -> completed (Job's done), with at least one after photo whose privacy-safe
    copy is ready. The customer then has a window to confirm. Again once completed: the job
    unchanged."""
    return await jobs.complete(user, job_id, queue)


@location_router.put(
    "",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Share my position while I am on my way (never stored in the database)",
    dependencies=[Depends(limit_pro_pings)],
    responses={
        **_PRO_JOB_ERRORS,
        status.HTTP_403_FORBIDDEN: _error("forbidden: only pros share their position."),
        status.HTTP_409_CONFLICT: _error(
            "not_on_the_way: the pro is not on the way to this job: not yet, already checked "
            "in, or the job moved on. Stop sending."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: a coordinate, accuracy or heading out of range or not a finite "
            "number, an unknown field, or recorded_at too far from the server's time."
        ),
        status.HTTP_429_TOO_MANY_REQUESTS: _error(
            "rate_limited: far too many positions from this pro; Retry-After has the wait."
        ),
        status.HTTP_503_SERVICE_UNAVAILABLE: _error(
            "location_unavailable: the position could not be kept (the store is down, or "
            "must not hold positions); drop it and send the next."
        ),
    },
)
async def share_pro_location(
    job_id: uuid.UUID, data: ProLocationIn, user: ProUser, locations: Locations
) -> None:
    """The pro's app sends this every few seconds from On my way to the check-in. Only the
    latest position of a job is kept, in memory, for a short time; it is deleted when the pro
    checks in or the job leaves on the way, and no position is ever written to the database.
    One sent too soon after the last, or older than it, is answered 204 and dropped."""
    await locations.ping(user, job_id, data)


@location_router.get(
    "",
    response_model=ProLocationOut,
    summary="See where my pro is while on the way (never stored in the database)",
    responses={
        status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN: _error("forbidden: only customers follow their pro."),
        status.HTTP_404_NOT_FOUND: _error("not_found: no job of the caller with this id."),
        status.HTTP_503_SERVICE_UNAVAILABLE: _error(
            "location_unavailable: the store must not hold positions (a deploy problem); "
            "there is none to show until it is fixed."
        ),
    },
)
async def get_pro_location(
    job_id: uuid.UUID, user: CustomerUser, locations: Locations
) -> ProLocationOut:
    """The pro's latest position on the way to the customer's own job, to poll every few
    seconds. `position` is null whenever there is none to show: before the first one, once it
    is too old, and whenever the pro is not on the way (the job's own status says which).
    Positions are kept in memory for a short time only, never in the database, and every
    response says `Cache-Control: no-store`."""
    return await locations.last_position(user, job_id)
