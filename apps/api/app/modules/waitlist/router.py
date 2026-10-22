from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.modules.auth.dependencies import OptionalUser
from app.modules.categories.service import CategoryService
from app.modules.service_areas.service import ServiceAreaService
from app.modules.waitlist.schemas import WaitlistJoin
from app.modules.waitlist.service import WaitlistService
from app.rate_limit import (
    IdentifierHasher,
    RateLimiter,
    client_ip,
    enforce_limit,
    get_identifier_hasher,
    get_rate_limiter,
)

router = APIRouter(prefix="/waitlist", tags=["waitlist"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_waitlist_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> WaitlistService:
    return WaitlistService(
        session,
        ServiceAreaService(session),
        CategoryService(session),
        settings.phone_allowed_country_codes,
    )


async def limit_waitlist_join(
    # Same name and model as the route's body, so FastAPI parses the body once.
    data: WaitlistJoin,
    request: Request,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    hasher: Annotated[IdentifierHasher, Depends(get_identifier_hasher)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """Per IP, then per contact; a contact enters the key only as a keyed hash."""
    identifiers = [("ip", client_ip(request))]
    identifiers += [("contact", hasher(contact)) for contact in (data.email, data.phone) if contact]
    for kind, identifier in identifiers:
        await enforce_limit(
            limiter,
            f"waitlist_join_{kind}",
            identifier,
            limit=settings.waitlist_join_limit,
            window_seconds=settings.auth_rate_limit_window_seconds,
            timeout_seconds=settings.rate_limit_timeout_seconds,
        )


@router.post(
    "",
    status_code=status.HTTP_202_ACCEPTED,
    response_class=Response,
    summary="Join the waitlist of an unserved ZIP",
    dependencies=[Depends(limit_waitlist_join)],
    responses={
        status.HTTP_202_ACCEPTED: {
            "description": "On the list; the same answer whether the contact already was."
        },
        status.HTTP_409_CONFLICT: _error("zip_served: the ZIP is served; create a request."),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "invalid_category: unknown or inactive category; validation_error: no email or "
            "phone, a bad ZIP, email or phone, or a phone outside the allowed country codes."
        ),
        status.HTTP_429_TOO_MANY_REQUESTS: {
            **_error("rate_limited: too many requests; retry later."),
            "headers": {
                "Retry-After": {
                    "description": "Seconds until the current limit window ends.",
                    "schema": {"type": "integer"},
                }
            },
        },
    },
)
async def join_waitlist(
    data: WaitlistJoin,
    user: OptionalUser,
    waitlist: Annotated[WaitlistService, Depends(get_waitlist_service)],
) -> None:
    """Asks to be told when the ZIP is served. No sign-in needed (a web visitor can join); with
    a valid bearer token the entry is linked to the account. The contact is used only for that
    notice. Joining twice with the same contact and ZIP refreshes the entry."""
    await waitlist.join(data, user)
