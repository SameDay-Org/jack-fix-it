import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.middleware import NoStoreRoute
from app.modules.auth.permissions import CustomerUser
from app.modules.receipts.schemas import ReceiptOut
from app.modules.receipts.service import ReceiptConfig, ReceiptService

# The customer's own payment and address: no HTTP cache keeps any answer, errors included.
router = APIRouter(prefix="/requests", tags=["receipts"], route_class=NoStoreRoute)


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_receipt_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> ReceiptService:
    return ReceiptService(session, ReceiptConfig.from_settings(settings))


@router.get(
    "/{request_id}/receipt",
    response_model=ReceiptOut,
    summary="The receipt of my job",
    responses={
        status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
        status.HTTP_403_FORBIDDEN: _error("forbidden: only customers have receipts."),
        status.HTTP_404_NOT_FOUND: _error(
            "not_found: no request of the caller with this id; receipt_not_available: its job's "
            "payment has not gone through yet."
        ),
    },
)
async def get_receipt(
    request_id: uuid.UUID,
    user: CustomerUser,
    receipts: Annotated[ReceiptService, Depends(get_receipt_service)],
) -> ReceiptOut:
    """The proof of payment of the request's job, from the moment its payment went through:
    the service, the tax when there is some, the tip once it went through and each amount
    returned to the payment method, the total paid, the card's brand and last 4 digits, and
    where the money stands. Never the platform's fee or the pro's payout."""
    return await receipts.for_customer(user, request_id)
