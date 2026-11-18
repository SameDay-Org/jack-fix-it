import uuid
from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.integrations.storage import StorageProvider, get_storage_provider
from app.middleware import NoStoreRoute
from app.modules.auth.permissions import CustomerUser, ProUser
from app.modules.disputes.models import TEXT_MAX_LENGTH
from app.modules.disputes.schemas import (
    CustomerDisputeView,
    DisputeIn,
    DisputeReplyIn,
    ProDisputeView,
)
from app.modules.disputes.service import DisputeConfig, DisputeService, utc_now
from app.queue import JobQueue, get_job_queue

# A problem the customer reports with a completed job, read by both sides (#75). What either side
# wrote is private: no HTTP cache keeps any answer, errors too.
customer_router = APIRouter(
    prefix="/jobs/{job_id}/dispute", tags=["disputes"], route_class=NoStoreRoute
)
pro_router = APIRouter(
    prefix="/pros/me/jobs/{job_id}/dispute", tags=["disputes"], route_class=NoStoreRoute
)


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_dispute_clock() -> Callable[[], datetime]:
    """FastAPI dependency: the server's clock for the dispute window (a fixed one in tests)."""
    return utc_now


def get_dispute_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    storage: Annotated[StorageProvider, Depends(get_storage_provider)],
    clock: Annotated[Callable[[], datetime], Depends(get_dispute_clock)],
) -> DisputeService:
    # The storage is reached only when a dispute has photos to sign.
    return DisputeService(session, DisputeConfig.from_settings(settings), storage, clock)


Disputes = Annotated[DisputeService, Depends(get_dispute_service)]
IdempotencyKey = Annotated[
    uuid.UUID | None,
    Header(
        alias="Idempotency-Key",
        description=(
            "A UUID the app makes once per draft and sends again with every retry of it. A "
            "retry answers 200 with the report the first call made, as it is now, and writes "
            "nothing; the same key with another body, or on another job, answers 409 "
            "idempotency_key_reused. With or without it, a job has one report."
        ),
    ),
]

_UNAUTHORIZED = _error("invalid_token: missing, invalid or expired token.")
_TEXT = (
    f"blank, longer than {TEXT_MAX_LENGTH} characters, holding a NUL, or empty once invisible "
    "characters are dropped"
)


@customer_router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=CustomerDisputeView,
    summary="Report a problem with my job",
    responses={
        status.HTTP_200_OK: {
            "model": CustomerDisputeView,
            "description": (
                "A problem was already reported on this job (a retry with the same "
                "Idempotency-Key and body, or another report): that report, unchanged."
            ),
        },
        status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN: _error("forbidden: only customers report a problem."),
        status.HTTP_404_NOT_FOUND: _error(
            "not_found: no job with this id of which the caller is the customer."
        ),
        status.HTTP_409_CONFLICT: _error(
            "job_not_disputable: the job is not completed (not done yet, confirmed by the "
            "customer or automatically, paid out, refunded or cancelled), or its window to "
            "report a problem has passed; idempotency_key_reused: the caller already used this "
            "Idempotency-Key with a different body or on another job; nothing was changed."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            f"validation_error: an unknown reason_code; a description {_TEXT}; photo_keys "
            "that are not the caller's own dispute_photo uploads, issued too long ago, "
            "repeated, already attached to a report, or more than DISPUTE_PHOTO_MAX_COUNT; an "
            "unknown field; a job_id or an Idempotency-Key that is not a UUID."
        ),
    },
)
async def report_problem(
    job_id: uuid.UUID,
    data: DisputeIn,
    user: CustomerUser,
    disputes: Disputes,
    queue: Annotated[JobQueue, Depends(get_job_queue)],
    response: Response,
    idempotency_key: IdempotencyKey = None,
) -> CustomerDisputeView:
    """The customer reports a problem with their completed job, before its window ends
    (`report_by` in the read): the job moves to disputed (Needs Attention) and its payout to the
    pro is held until an admin resolves it. One report per job: sending again returns the first
    one, unchanged (200).

    Contact details in the description are masked before it is stored; only the masked text is
    kept. The pro is notified; photos are shown to them once their safe copy is ready."""
    view, created = await disputes.report(user, job_id, data, queue, idempotency_key)
    if not created:
        response.status_code = status.HTTP_200_OK
    return view


@customer_router.get(
    "",
    response_model=CustomerDisputeView,
    summary="Read the problem I reported on my job",
    responses={
        status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN: _error("forbidden: only customers."),
        status.HTTP_404_NOT_FOUND: _error(
            "not_found: no job with this id of which the caller is the customer."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: a job_id that is not a UUID."
        ),
    },
)
async def read_my_problem(
    job_id: uuid.UUID, user: CustomerUser, disputes: Disputes
) -> CustomerDisputeView:
    """The caller's report on their job, or null, whether they may report one now, and until
    when. The pro's reply is not part of it: it is for the admin who resolves the report."""
    return await disputes.customer_view(user, job_id)


@pro_router.get(
    "",
    response_model=ProDisputeView,
    summary="Read the problem reported on my job",
    responses={
        status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN: _error("forbidden: only pros."),
        status.HTTP_404_NOT_FOUND: _error(
            "not_found: no job with this id of which the caller is the pro."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: a job_id that is not a UUID."
        ),
    },
)
async def read_reported_problem(
    job_id: uuid.UUID, user: ProUser, disputes: Disputes
) -> ProDisputeView:
    """The customer's report on the caller's job, or null: the reason, the description as
    stored (masked), the photos' safe copies once ready, and the pro's own reply."""
    return await disputes.pro_view(user, job_id)


@pro_router.post(
    "/reply",
    response_model=ProDisputeView,
    summary="Reply to the problem reported on my job",
    responses={
        status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN: _error("forbidden: only pros."),
        status.HTTP_404_NOT_FOUND: _error(
            "not_found: no job with this id of which the caller is the pro."
        ),
        status.HTTP_409_CONFLICT: _error(
            "no_open_dispute: no problem was reported on the job, or it is resolved; "
            "already_replied: the pro already sent a different reply."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            f"validation_error: a message {_TEXT}; an unknown field; a job_id that is not a UUID."
        ),
    },
)
async def reply_to_problem(
    job_id: uuid.UUID, data: DisputeReplyIn, user: ProUser, disputes: Disputes
) -> ProDisputeView:
    """The pro's one answer to the report, for the admin who resolves it. Sending the same text
    again returns the view unchanged. Contact details are masked before it is stored."""
    return await disputes.reply(user, job_id, data)
