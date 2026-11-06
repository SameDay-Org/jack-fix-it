import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.integrations.stripe_payments import StripePayments, get_stripe_payments
from app.modules.auth.permissions import CustomerUser
from app.modules.payments.schemas import PaymentCreate, PaymentSheetOut
from app.modules.payments.service import PaymentsConfig, PaymentService

router = APIRouter(prefix="/requests", tags=["payments"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_payment_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    stripe: Annotated[StripePayments | None, Depends(get_stripe_payments)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> PaymentService:
    return PaymentService(session, stripe, PaymentsConfig.from_settings(settings))


@router.post(
    "/{request_id}/quotes/{quote_id}/payment",
    status_code=status.HTTP_200_OK,
    response_model=PaymentSheetOut,
    summary="Pay for the quote I accepted",
    responses={
        status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
        status.HTTP_403_FORBIDDEN: _error("forbidden: only customers pay for quotes."),
        status.HTTP_404_NOT_FOUND: _error(
            "not_found: no request of the caller with this id, or no quote with this id on it."
        ),
        status.HTTP_409_CONFLICT: _error(
            "payment_not_available: the request is not accepted or this quote is not its "
            "accepted one, or the payment already succeeded (the job exists or is being "
            "created) or its PaymentIntent is closed; pro_not_hireable: the quote's pro can no "
            "longer be hired (not approved, or payouts disabled). Nothing was created. "
            "payment_needs_review: an earlier PaymentIntent create never answered and Stripe "
            "may have forgotten it; support resolves the payment before another is created."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: a malformed id, or a field in the body: the amounts come from "
            "the accepted quote, never from the client."
        ),
        status.HTTP_502_BAD_GATEWAY: _error(
            "payments_error: Stripe refused the call; nothing changed, the payment can be "
            "asked for again."
        ),
        status.HTTP_503_SERVICE_UNAVAILABLE: _error(
            "not_configured: payments are not configured; payments_unavailable: Stripe is not "
            "reachable or asked to retry later; nothing changed, retry later."
        ),
    },
)
async def create_payment(
    request_id: uuid.UUID,
    quote_id: uuid.UUID,
    user: CustomerUser,
    payments: Annotated[PaymentService, Depends(get_payment_service)],
    body: Annotated[PaymentCreate | None, Body()] = None,
) -> PaymentSheetOut:
    """What the Payment Sheet needs to charge the customer for the quote they accepted: the
    PaymentIntent's client secret, the customer and an ephemeral key for it, the publishable
    key, and the amount, the tax and the total shown before paying. The amounts are the
    accepted quote's, computed on the server; the body takes no field. The first call creates
    the PaymentIntent; later calls return the same one (a new ephemeral key each time), until
    the payment succeeds (then the job exists: 409). The pro is checked again on every call:
    one who can no longer be hired is a 409, and nothing is created."""
    return await payments.payment_sheet(user, request_id, quote_id)
