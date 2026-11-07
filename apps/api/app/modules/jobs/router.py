import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.modules.auth.permissions import CustomerUser, ProUser
from app.modules.jobs.errors import ATTEMPTS_REMAINING_HEADER
from app.modules.jobs.execution import JobExecutionConfig, JobExecutionService
from app.modules.jobs.schemas import CheckInIn, CustomerJob, OnTheWayIn, ProJob, ProJobPage
from app.queue import JobQueue, get_job_queue

# The customer's side: the job of their own request (#63).
customer_router = APIRouter(prefix="/requests", tags=["jobs"])
# The pro's side: their own jobs and the steps they take on them (#63).
router = APIRouter(prefix="/pros/me/jobs", tags=["jobs"])

_UNAUTHORIZED = {"model": ErrorResponse, "description": "invalid_token: missing or expired."}


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_job_execution_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    queue: Annotated[JobQueue, Depends(get_job_queue)],
) -> JobExecutionService:
    return JobExecutionService(session, JobExecutionConfig.from_settings(settings), queue)


Jobs = Annotated[JobExecutionService, Depends(get_job_execution_service)]

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
    have not checked in), the history and what the customer paid."""
    return await jobs.customer_job(user, request_id)


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
async def mark_on_the_way(job_id: uuid.UUID, data: OnTheWayIn, user: ProUser, jobs: Jobs) -> ProJob:
    """Scheduled -> on the way, with an ETA the customer sees; the customer gets an arrival
    code to give the pro on arrival. Again while on the way: only the ETA changes (the code
    stays)."""
    return await jobs.on_the_way(user, job_id, data.eta_minutes)


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
async def check_in(job_id: uuid.UUID, data: CheckInIn, user: ProUser, jobs: Jobs) -> ProJob:
    """Arrived: the code the customer gives the pro, and where the pro is (recorded only). Once
    checked in, calling it again answers the job unchanged."""
    return await jobs.check_in(user, job_id, data.arrival_code, data.lat, data.lng)


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
async def start_job(job_id: uuid.UUID, user: ProUser, jobs: Jobs) -> ProJob:
    """On the way -> working, after the check-in."""
    return await jobs.start(user, job_id)
