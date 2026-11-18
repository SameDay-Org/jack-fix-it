import uuid
from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.integrations.storage import StorageProvider, get_storage_provider
from app.integrations.stripe_refunds import StripeRefunds, get_stripe_refunds
from app.middleware import NoStoreRoute
from app.modules.auth.permissions import AdminUser, CustomerUser, PanelUser, ProUser
from app.modules.disputes.models import NOTE_MAX_LENGTH, TEXT_MAX_LENGTH, DisputeStatus
from app.modules.disputes.resolution import DisputeResolver, ResolutionConfig
from app.modules.disputes.schemas import (
    CustomerDisputeView,
    DisputeIn,
    DisputeReplyIn,
    ProDisputeView,
)
from app.modules.disputes.service import DisputeConfig, DisputeService, utc_now
from app.modules.disputes.staff import DisputeStaffReader
from app.modules.disputes.staff_schemas import (
    DisputeResolutionOut,
    DisputeResolveIn,
    StaffDisputeList,
    StaffDisputeOut,
)
from app.queue import JobQueue, get_job_queue

# A problem the customer reports with a completed job, read by both sides (#75). What either side
# wrote is private: no HTTP cache keeps any answer, errors too.
customer_router = APIRouter(
    prefix="/jobs/{job_id}/dispute", tags=["disputes"], route_class=NoStoreRoute
)
pro_router = APIRouter(
    prefix="/pros/me/jobs/{job_id}/dispute", tags=["disputes"], route_class=NoStoreRoute
)
# Staff (#76): agents and admins read, admins resolve. Never stored by a cache.
staff_router = APIRouter(prefix="/admin/disputes", tags=["disputes"], route_class=NoStoreRoute)


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


def get_dispute_staff_reader(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    storage: Annotated[StorageProvider, Depends(get_storage_provider)],
) -> DisputeStaffReader:
    return DisputeStaffReader(
        session,
        storage,
        settings.download_url_ttl_seconds,
        settings.request_list_default_limit,
        settings.request_list_max_limit,
    )


def get_dispute_resolver(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    stripe: Annotated[StripeRefunds | None, Depends(get_stripe_refunds)],
    clock: Annotated[Callable[[], datetime], Depends(get_dispute_clock)],
) -> DisputeResolver:
    return DisputeResolver(session, stripe, ResolutionConfig.from_settings(settings), clock)


StaffDisputes = Annotated[DisputeStaffReader, Depends(get_dispute_staff_reader)]


@staff_router.get(
    "",
    response_model=StaffDisputeList,
    summary="List disputes (staff)",
    responses={
        status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
        status.HTTP_403_FORBIDDEN: _error("forbidden: only agents and admins."),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error("validation_error: a bad status or limit."),
    },
)
async def list_disputes(
    user: PanelUser,
    disputes: StaffDisputes,
    status_filter: Annotated[
        DisputeStatus | None,
        Query(alias="status", description="open or resolved; every dispute when absent."),
    ] = None,
    limit: Annotated[
        int | None,
        Query(gt=0, description="At most this many (capped at REQUEST_LIST_MAX_LIMIT)."),
    ] = None,
) -> StaffDisputeList:
    """Disputes for the BDC and admins, oldest first (the longest waiting on top): the
    request's public code, the reason, the money, the parties' first names, when it was
    opened, and how it was resolved. No text, no photo: those are in the audited detail."""
    return await disputes.listed(status_filter, limit)


@staff_router.get(
    "/{dispute_id}",
    response_model=StaffDisputeOut,
    summary="Read a dispute (staff)",
    responses={
        status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
        status.HTTP_403_FORBIDDEN: _error("forbidden: only agents and admins."),
        status.HTTP_404_NOT_FOUND: _error("not_found: no dispute with this id."),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error("validation_error: a malformed id."),
    },
)
async def read_dispute(
    dispute_id: uuid.UUID, user: PanelUser, disputes: StaffDisputes
) -> StaffDisputeOut:
    """A dispute in full: both sides' text as stored (contact details masked), the photos'
    safe copies (signed URLs), the job's history, its payment, refund and transfer, and the
    resolution with its note. Every read is recorded in the audit log."""
    return await disputes.detail(user, dispute_id)


@staff_router.post(
    "/{dispute_id}/resolve",
    response_model=DisputeResolutionOut,
    summary="Resolve a dispute (admin)",
    responses={
        status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
        status.HTTP_403_FORBIDDEN: _error("forbidden: only admins resolve disputes."),
        status.HTTP_404_NOT_FOUND: _error("not_found: no dispute with this id."),
        status.HTTP_409_CONFLICT: _error(
            "dispute_already_resolved: resolved with another decision or split (the same one "
            "again answers 200). refund_already_attempted: a refund of another amount was "
            "tried and the dispute is still open; only the same decision may be retried. "
            "resolution_in_progress: another resolve is calling Stripe; retry in a few "
            "minutes. dispute_needs_review: the job's payment cannot be refunded as is, or "
            "Stripe holds refunds that cannot be matched; nothing is created in Stripe."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: a malformed id, an unknown decision, pro_release_cents on a "
            "release or a refund (or missing on a partial), or a blank note (at most "
            f"{NOTE_MAX_LENGTH} characters). invalid_split: pro_release_cents is not more "
            "than 0 and less than the pro's payout."
        ),
        status.HTTP_502_BAD_GATEWAY: _error(
            "payments_error: Stripe refused the refund; the dispute stays open and the job "
            "disputed. The same decision can be sent again, but Stripe answers it with the "
            "same refusal for 24 h (one idempotency key per refund)."
        ),
        status.HTTP_503_SERVICE_UNAVAILABLE: _error(
            "not_configured: refunds are not configured. payments_unavailable: Stripe is not "
            "reachable; the dispute stays open, the same decision can be sent again."
        ),
    },
)
async def resolve_dispute(
    dispute_id: uuid.UUID,
    data: DisputeResolveIn,
    user: AdminUser,
    resolver: Annotated[DisputeResolver, Depends(get_dispute_resolver)],
    queue: Annotated[JobQueue, Depends(get_job_queue)],
) -> DisputeResolutionOut:
    """Settles the dispute once. `release`: the pro is paid their payout in full; the job
    moves to paid_out once the transfer is made. `refund`: the customer's total, tax included,
    goes back to their payment method; the job moves to refunded; no transfer. `partial`: the
    pro is paid `pro_release_cents` and the customer gets back the share of their total that
    is not released (rounded half up to the cent); the platform keeps the rest. The amounts
    come from the job's frozen payment, never from the client beyond `pro_release_cents`.
    Sending the same decision again completes what is missing and changes nothing else; a
    different one after the resolution is a 409. Both sides are notified, never with the
    note, which is kept with the dispute and in the audit log."""
    return await resolver.resolve(user, dispute_id, data, queue)
