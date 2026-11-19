from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.middleware import NoStoreRoute
from app.modules.auth.permissions import ProUser
from app.modules.earnings.schemas import EarningsPage
from app.modules.earnings.service import EarningsConfig, EarningsService
from app.rate_limit import RateLimiter, enforce_limit, get_rate_limiter

# A pro's own money (#70). No HTTP cache keeps an answer, errors included.
router = APIRouter(prefix="/pros/me/earnings", tags=["pros"], route_class=NoStoreRoute)


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_earnings_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> EarningsService:
    return EarningsService(session, EarningsConfig.from_settings(settings))


async def limit_earnings_reads(
    user: ProUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """EARNINGS_READ_LIMIT reads per pro per EARNINGS_READ_WINDOW_SECONDS."""
    await enforce_limit(
        limiter,
        "earnings_read",
        str(user.id),
        limit=settings.earnings_read_limit,
        window_seconds=settings.earnings_read_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


@router.get(
    "",
    response_model=EarningsPage,
    summary="My earnings",
    dependencies=[Depends(limit_earnings_reads)],
    responses={
        status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
        status.HTTP_403_FORBIDDEN: _error("forbidden: only pros."),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error("validation_error: a bad cursor or limit."),
        status.HTTP_429_TOO_MANY_REQUESTS: _error(
            "rate_limited: more than EARNINGS_READ_LIMIT reads in the window; Retry-After says "
            "when to try again."
        ),
    },
)
async def read_my_earnings(
    user: ProUser,
    earnings: Annotated[EarningsService, Depends(get_earnings_service)],
    cursor: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int | None, Query(gt=0, description="Capped at the list maximum.")] = None,
) -> EarningsPage:
    """What the caller receives for each of their jobs whose work is done, newest completion
    first, and a summary over all of them: awaiting the customer's confirmation (with when it
    confirms itself at the latest), on its way (confirmed, the transfer to be made), on hold
    (a reported problem, or under review) and paid. The amounts are the payout frozen at
    payment, the "you'll receive" of the quote. The pro is the caller: no id is taken. Never
    the customer's name, contacts or address, the platform's fee, or a Stripe id."""
    return await earnings.read(user, cursor, limit)
