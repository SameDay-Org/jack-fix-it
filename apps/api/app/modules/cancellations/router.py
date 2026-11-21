import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.middleware import NoStoreRoute
from app.modules.auth.permissions import CustomerUser, ProUser
from app.modules.cancellations.models import NOTE_MAX_LENGTH
from app.modules.cancellations.schemas import (
    CancellationOut,
    CancelPreviewOut,
    CustomerCancelIn,
    ProCancelIn,
    ProCancellationOut,
)
from app.modules.cancellations.service import CancelConfig, CancellationService
from app.modules.jobs.location import JobLocationStore, get_job_location_store
from app.queue import JobQueue, get_job_queue
from app.rate_limit import RateLimiter, enforce_limit, get_rate_limiter

# The customer cancels their job (#69). Amounts and the refund's state are the customer's own:
# no HTTP cache keeps any answer, errors too.
customer_router = APIRouter(
    prefix="/jobs/{job_id}", tags=["cancellations"], route_class=NoStoreRoute
)
# The pro cancels their job (#69): the customer gets everything back. Never cached either.
pro_router = APIRouter(
    prefix="/pros/me/jobs/{job_id}", tags=["cancellations"], route_class=NoStoreRoute
)


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_cancellation_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    locations: Annotated[JobLocationStore, Depends(get_job_location_store)],
) -> CancellationService:
    return CancellationService(session, CancelConfig.from_settings(settings), locations)


async def limit_cancel_previews(
    user: CustomerUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """CANCEL_PREVIEW_LIMIT previews per customer per CANCEL_PREVIEW_WINDOW_SECONDS."""
    await enforce_limit(
        limiter,
        "cancel_preview",
        str(user.id),
        limit=settings.cancel_preview_limit,
        window_seconds=settings.cancel_preview_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


async def limit_cancels(
    user: CustomerUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """CANCEL_WRITE_LIMIT cancels per customer per CANCEL_WRITE_WINDOW_SECONDS, whatever
    the job and the answer: a retry with the same Idempotency-Key counts too (it reads
    and locks like the first)."""
    await enforce_limit(
        limiter,
        "cancel_write",
        str(user.id),
        limit=settings.cancel_write_limit,
        window_seconds=settings.cancel_write_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


async def limit_pro_cancels(
    user: ProUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """CANCEL_WRITE_LIMIT cancels per pro per CANCEL_WRITE_WINDOW_SECONDS, as for customers:
    the same window, counted per user."""
    await enforce_limit(
        limiter,
        "cancel_write",
        str(user.id),
        limit=settings.cancel_write_limit,
        window_seconds=settings.cancel_write_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


Cancellations = Annotated[CancellationService, Depends(get_cancellation_service)]
IdempotencyKey = Annotated[
    uuid.UUID | None,
    Header(
        alias="Idempotency-Key",
        description=(
            "A UUID the app makes once per cancel and sends again with every retry of it. A "
            "retry answers 200 with the cancellation as it is now and writes nothing; the "
            "same key with another body, or on another job, answers 409 "
            "idempotency_key_reused. With or without it, a job is cancelled once."
        ),
    ),
]

_UNAUTHORIZED = _error("invalid_token: missing, invalid or expired token.")
_FORBIDDEN = _error("forbidden: only customers cancel here (a pro's own cancel is separate).")
_NOT_FOUND = _error("not_found: no job with this id of which the caller is the customer.")
_RATE_LIMITED = _error(
    "rate_limited: too many previews or cancels by this customer in the window; Retry-After "
    "says when to try again."
)
_NOT_ALLOWED = (
    "cancel_not_allowed: the work started, or the job is done, confirmed, paid out, disputed "
    "or refunded (the message names its status): report a problem instead; "
    "cancel_needs_review: the job's payment needs a look by staff first"
)


@customer_router.get(
    "/cancel-preview",
    response_model=CancelPreviewOut,
    summary="What cancelling my job now would cost",
    dependencies=[Depends(limit_cancel_previews)],
    responses={
        401: _UNAUTHORIZED,
        403: _FORBIDDEN,
        404: _NOT_FOUND,
        409: _error(f"{_NOT_ALLOWED}. Nothing is written."),
        422: _error("validation_error: a job_id that is not a UUID."),
        429: _RATE_LIMITED,
    },
)
async def cancel_preview(
    job_id: uuid.UUID, user: CustomerUser, cancellations: Cancellations
) -> CancelPreviewOut:
    """The fee kept and the refund given back if the customer cancels now, computed on the
    server: free before the pro taps On my way; after it (on the way or arrived) a share of the
    job price is kept and the rest of the payment, tax included, is refunded. Show it before
    the customer confirms, and send its fee_cents back as expected_fee_cents."""
    return await cancellations.preview(user, job_id)


@customer_router.post(
    "/cancel",
    response_model=CancellationOut,
    summary="Cancel my job",
    dependencies=[Depends(limit_cancels)],
    responses={
        401: _UNAUTHORIZED,
        403: _FORBIDDEN,
        404: _NOT_FOUND,
        409: _error(
            f"{_NOT_ALLOWED}; cancel_fee_changed: expected_fee_cents differs from the fee "
            "cancelling now costs (the pro set off since the preview); idempotency_key_reused: "
            "the caller already used this Idempotency-Key with a different body or on another "
            "job. Nothing was changed."
        ),
        422: _error(
            "validation_error: an unknown or a pro's reason_code; a note longer than "
            f"{NOTE_MAX_LENGTH} characters, holding a NUL, or empty once invisible characters "
            "are dropped; a negative expected_fee_cents; an unknown field (an amount above "
            "all); a job_id or an Idempotency-Key that is not a UUID."
        ),
        429: _RATE_LIMITED,
    },
)
async def cancel_job(
    job_id: uuid.UUID,
    data: CustomerCancelIn,
    user: CustomerUser,
    cancellations: Cancellations,
    queue: Annotated[JobQueue, Depends(get_job_queue)],
    idempotency_key: IdempotencyKey = None,
) -> CancellationOut:
    """The customer cancels their scheduled or on-the-way job. The job and its request are
    cancelled; the refund (the payment minus the fee, if any) goes back to the original payment
    method through Stripe, made by the server: refund_status says where it stands. The pro is
    notified. A job is cancelled once: sending again returns that cancellation (200)."""
    cancellation, _ = await cancellations.cancel_as_customer(
        user, job_id, data, queue, idempotency_key
    )
    return cancellation


@pro_router.post(
    "/cancel",
    response_model=ProCancellationOut,
    summary="Cancel a job I can no longer do (pro)",
    dependencies=[Depends(limit_pro_cancels)],
    responses={
        401: _UNAUTHORIZED,
        403: _error("forbidden: only pros cancel here (a customer's cancel is separate)."),
        404: _error("not_found: no job with this id of which the caller is the pro."),
        409: _error(
            "cancel_not_allowed: the work started, or the job is done, confirmed, paid out, "
            "disputed or refunded (the message names its status); cancel_needs_review: the "
            "job's payment needs a look by staff first; idempotency_key_reused: the caller "
            "already used this Idempotency-Key with a different body or on another job. "
            "Nothing was changed."
        ),
        422: _error(
            "validation_error: an unknown or a customer's reason_code; a note longer than "
            f"{NOTE_MAX_LENGTH} characters, holding a NUL, or empty once invisible characters "
            "are dropped; an unknown field; a job_id or an Idempotency-Key that is not a UUID."
        ),
        429: _error(
            "rate_limited: too many cancels by this pro in the window; Retry-After says when to "
            "try again."
        ),
    },
)
async def pro_cancel_job(
    job_id: uuid.UUID,
    data: ProCancelIn,
    user: ProUser,
    cancellations: Cancellations,
    queue: Annotated[JobQueue, Depends(get_job_queue)],
    idempotency_key: IdempotencyKey = None,
) -> ProCancellationOut:
    """The pro cancels their scheduled or on-the-way job. The customer is never charged: their
    whole payment, tax included, goes back to the original payment method through Stripe. The
    job and its request are cancelled (the request is not reopened: the customer starts a new
    one), and the customer is notified. A job is cancelled once: sending again, or after the
    customer cancelled, returns that cancellation (200)."""
    cancellation, _ = await cancellations.cancel_as_pro(user, job_id, data, queue, idempotency_key)
    return cancellation
