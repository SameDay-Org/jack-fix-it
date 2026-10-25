import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.modules.auth.permissions import CustomerUser, ProUser
from app.modules.quotes.schemas import CustomerQuoteList, QuoteCreate, QuoteOut
from app.modules.quotes.service import QuoteService
from app.queue import JobQueue, get_job_queue

router = APIRouter(prefix="/pros/me/opportunities", tags=["pros"])
# The customer's side: the quotes on their own requests (#188).
customer_router = APIRouter(prefix="/requests", tags=["quotes"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_quote_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    queue: Annotated[JobQueue, Depends(get_job_queue)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> QuoteService:
    return QuoteService(session, queue, settings.job_enqueue_timeout_seconds)


@router.post(
    "/{dispatch_id}/quote",
    status_code=status.HTTP_201_CREATED,
    response_model=QuoteOut,
    summary="Send a quote for one of my opportunities",
    responses={
        status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
        status.HTTP_403_FORBIDDEN: _error("forbidden: only pros send quotes."),
        status.HTTP_404_NOT_FOUND: _error("not_found: no opportunity of the caller with this id."),
        status.HTTP_409_CONFLICT: _error(
            "quote_exists: the caller already quoted this request; not_quotable: the "
            "opportunity was declined or expired, or the request is no longer open for quotes."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: amount or duration not a positive integer or above the "
            "platform's cap, scope empty or too long, proposed_start_at not a future time "
            "with a time zone, or a field the server sets (status, expires_at, pro or request)."
        ),
        status.HTTP_503_SERVICE_UNAVAILABLE: _error(
            "not_configured: quoting is not configured yet (the quote lifetime is not set, "
            "or a quote cap is set to an invalid value)."
        ),
    },
)
async def submit_quote(
    dispatch_id: uuid.UUID,
    data: QuoteCreate,
    user: ProUser,
    quotes: Annotated[QuoteService, Depends(get_quote_service)],
) -> QuoteOut:
    """A fixed-price quote: the price in cents, what it includes, the estimated duration and a
    proposed start. It expires after the platform's quote lifetime. The first quote on a
    request makes it Quote Ready for the customer."""
    return await quotes.submit(user, dispatch_id, data)


@customer_router.get(
    "/{request_id}/quotes",
    response_model=CustomerQuoteList,
    summary="Compare the quotes on one of my service requests",
    responses={
        status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
        status.HTTP_403_FORBIDDEN: _error("forbidden: only customers have service requests."),
        status.HTTP_404_NOT_FOUND: _error("not_found: no request of the caller with this id."),
    },
)
async def list_request_quotes(
    request_id: uuid.UUID,
    user: CustomerUser,
    quotes: Annotated[QuoteService, Depends(get_quote_service)],
) -> CustomerQuoteList:
    """The quotes the customer can choose from: the pending ones not yet expired, and the
    accepted one while the payment is pending. Empty until the request is Quote Ready, and
    once it is closed. Each shows the price, what it includes (contact details masked), the
    duration, the proposed start, when it expires, and the pro's public card."""
    return await quotes.list_for_customer(user, request_id)
