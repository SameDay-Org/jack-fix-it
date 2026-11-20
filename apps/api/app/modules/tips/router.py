import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, Header, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.integrations.stripe_payments import StripePayments, get_stripe_payments
from app.middleware import NoStoreRoute
from app.modules.auth.permissions import CustomerUser
from app.modules.tips.schemas import TipCreate, TipCreateOut
from app.modules.tips.service import TipConfig, TipService
from app.rate_limit import RateLimiter, enforce_limit, get_rate_limiter

# The customer's tip (#273). Its answer carries a live CustomerSession credential, as the
# checkout's does: no HTTP cache may keep it, nor any error of the route.
router = APIRouter(prefix="/requests", tags=["tips"], route_class=NoStoreRoute)


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_tip_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    stripe: Annotated[StripePayments | None, Depends(get_stripe_payments)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> TipService:
    return TipService(session, stripe, TipConfig.from_settings(settings))


async def limit_tip_choices(
    user: CustomerUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """TIP_CHOICE_LIMIT choices per customer per TIP_CHOICE_WINDOW_SECONDS, replays included,
    before any Stripe call (#510 round 1)."""
    await enforce_limit(
        limiter,
        "tip_choice",
        str(user.id),
        limit=settings.tip_choice_limit,
        window_seconds=settings.tip_choice_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


IdempotencyKey = Annotated[
    uuid.UUID | None,
    Header(
        alias="Idempotency-Key",
        description=(
            "A UUID the app makes once per choice and sends again with every retry of it. A "
            "retry answers 200 with the tip as it is now (and the same attempt's Payment Sheet "
            "while it is still the one to pay) and changes nothing; the same key with another "
            "body, or on another job, answers 409 idempotency_key_reused."
        ),
    ),
]


@router.post(
    "/{request_id}/job/tip",
    status_code=status.HTTP_200_OK,
    response_model=TipCreateOut,
    summary="Tip the pro of my confirmed job, or choose no tip",
    dependencies=[Depends(limit_tip_choices)],
    responses={
        status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
        status.HTTP_403_FORBIDDEN: _error("forbidden: only customers tip."),
        status.HTTP_404_NOT_FOUND: _error(
            "not_found: no request of the caller with this id, or no job on it."
        ),
        status.HTTP_409_CONFLICT: _error(
            "tip_not_available: the job was never confirmed (under way, disputed, refunded, "
            "cancelled) or its tip window closed; tip_already_paid: the tip succeeded; "
            "tip_in_progress: its payment is processing, or another change of the tip is under "
            "way; tip_needs_review: support has to look at the tip first; "
            "idempotency_key_reused: the key went with another body or job. Nothing changed."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "tip_percent_not_offered: the percent is not one of the job's presets; "
            "tip_amount_out_of_range: the amount, or what the percent comes to, is outside the "
            "job's bounds; validation_error: a malformed id or body."
        ),
        status.HTTP_429_TOO_MANY_REQUESTS: _error(
            "rate_limited: more than TIP_CHOICE_LIMIT choices in the window; Retry-After says "
            "when to try again."
        ),
        status.HTTP_502_BAD_GATEWAY: _error(
            "payments_error: Stripe refused the call; nothing changed, try again."
        ),
        status.HTTP_503_SERVICE_UNAVAILABLE: _error(
            "not_configured: payments are not configured; payments_unavailable: Stripe is not "
            "reachable or asked to retry later; nothing changed, retry later."
        ),
    },
)
async def choose_tip(
    request_id: uuid.UUID,
    user: CustomerUser,
    tips: Annotated[TipService, Depends(get_tip_service)],
    body: Annotated[TipCreate, Body()],
    idempotency_key: IdempotencyKey = None,
) -> TipCreateOut:
    """The customer's tip for the pro of their confirmed job, inside the window the job's tip
    shows (closes_at): "No tip", one of the offered percents, or an amount within the bounds.
    The server computes every amount. A tip to pay comes with what the Payment Sheet needs
    (the same PaymentIntent while the amount stays the same; a new amount cancels the earlier
    one first); "No tip" comes with no sheet. Sending the same choice again is safe."""
    return await tips.choose(user, request_id, body, idempotency_key)
