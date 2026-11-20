from typing import Annotated

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.middleware import NoStoreRoute
from app.modules.interest.schemas import InterestJoin
from app.modules.interest.service import InterestService
from app.rate_limit import (
    IdentifierHasher,
    RateLimiter,
    enforce_limit,
    get_identifier_hasher,
    get_rate_limiter,
)
from app.web_service import WebService

# The app-launch interest list (#409): the web app's server only (app.web_service).
router = APIRouter(prefix="/interest", tags=["interest"], route_class=NoStoreRoute)


def get_interest_service(
    session: Annotated[AsyncSession, Depends(get_session)],
) -> InterestService:
    return InterestService(session)


async def limit_interest_join(
    # Same name and model as the route's body, so FastAPI parses the body once.
    data: InterestJoin,
    caller: WebService,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    hasher: Annotated[IdentifierHasher, Depends(get_identifier_hasher)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """INTEREST_IP_LIMIT joins per visitor address, then INTEREST_EMAIL_LIMIT per email, per
    INTEREST_WINDOW_SECONDS. The address is the one the web service forwarded; the email enters
    the key only as a keyed hash."""
    for kind, identifier, limit in (
        ("ip", caller.visitor_ip, settings.interest_ip_limit),
        ("email", hasher(data.email), settings.interest_email_limit),
    ):
        await enforce_limit(
            limiter,
            f"interest_join_{kind}",
            identifier,
            limit=limit,
            window_seconds=settings.interest_window_seconds,
            timeout_seconds=settings.rate_limit_timeout_seconds,
        )


@router.post(
    "",
    status_code=status.HTTP_202_ACCEPTED,
    response_class=Response,
    summary="Join the app-launch interest list (the web service only)",
    dependencies=[Depends(limit_interest_join)],
    responses={
        status.HTTP_202_ACCEPTED: {
            "description": "On the list: the same answer whether the email already was."
        },
        status.HTTP_401_UNAUTHORIZED: {
            "model": ErrorResponse,
            "description": "invalid_service_key: no X-JFI-Web-Key, or not the web service's.",
        },
        status.HTTP_422_UNPROCESSABLE_CONTENT: {
            "model": ErrorResponse,
            "description": "validation_error: a bad email, locale, source or consent_version, "
            "or an unknown field.",
        },
        status.HTTP_429_TOO_MANY_REQUESTS: {
            "model": ErrorResponse,
            "description": "rate_limited: too many joins from this visitor's address or for "
            "this email in the window; Retry-After says when to try again.",
        },
    },
)
async def join_interest(
    data: InterestJoin,
    service: Annotated[InterestService, Depends(get_interest_service)],
) -> Response:
    """Puts the email on the list of people who want to hear when the app is in the stores,
    with the version of the consent words the visitor saw and the time. Called by the web app's
    server with its key (`X-JFI-Web-Key`) and the visitor's address (`X-JFI-Client-IP`): the
    browser never calls it. Nothing is sent to the email."""
    await service.join(data)
    return Response(status_code=status.HTTP_202_ACCEPTED)
