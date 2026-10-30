import html
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, status
from fastapi.responses import HTMLResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.integrations.stripe_connect import StripeConnect, get_stripe_connect
from app.modules.auth.permissions import ProUser
from app.modules.payouts.schemas import OnboardingLinkOut, PayoutsOut
from app.modules.payouts.service import PayoutsConfig, PayoutsService
from app.modules.pros.service import ProService
from app.rate_limit import RateLimiter, enforce_limit, get_rate_limiter

router = APIRouter(prefix="/pros/me/payouts", tags=["payouts"])
# Browser pages, not API: Stripe's return_url and refresh_url must be web URLs.
pages_router = APIRouter(prefix="/payouts/onboarding", include_in_schema=False)


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_payouts_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    stripe: Annotated[StripeConnect | None, Depends(get_stripe_connect)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> PayoutsService:
    return PayoutsService(
        session, ProService(session), stripe, PayoutsConfig.from_settings(settings)
    )


async def limit_onboarding_links(
    user: ProUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """PAYOUTS_ONBOARDING_LINK_LIMIT links per pro per PAYOUTS_ONBOARDING_LINK_WINDOW_SECONDS:
    each one is a Stripe call."""
    await enforce_limit(
        limiter,
        "payouts_onboarding_link",
        str(user.id),
        limit=settings.payouts_onboarding_link_limit,
        window_seconds=settings.payouts_onboarding_link_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
    status.HTTP_403_FORBIDDEN: _error("forbidden: only pros have a payout account."),
    status.HTTP_502_BAD_GATEWAY: _error(
        "payments_error: Stripe refused the call, e.g. for an account deleted on its side."
    ),
    status.HTTP_503_SERVICE_UNAVAILABLE: _error(
        "payments_unavailable: payments are not configured, or Stripe is not reachable; "
        "nothing changed, retry later."
    ),
}


@router.post(
    "/onboarding-link",
    response_model=OnboardingLinkOut,
    summary="Get a payout onboarding link",
    dependencies=[Depends(limit_onboarding_links)],
    responses={
        **_RESPONSES,
        status.HTTP_409_CONFLICT: _error(
            "payouts_needs_review: an earlier account create is unresolved: Stripe shows no "
            "payout account for the pro, more than one, or could not be searched to the end; "
            "nothing was created. Support resolves it."
        ),
        status.HTTP_429_TOO_MANY_REQUESTS: {
            **_error("rate_limited: too many onboarding links; retry later."),
            "headers": {
                "Retry-After": {
                    "description": "Seconds until the current limit window ends.",
                    "schema": {"type": "integer"},
                }
            },
        },
    },
)
async def create_onboarding_link(
    user: ProUser, payouts: Annotated[PayoutsService, Depends(get_payouts_service)]
) -> OnboardingLinkOut:
    """A single-use link to Stripe's hosted onboarding, where the pro enters the details
    Stripe needs to pay them out. The first call creates the pro's payout account (one per pro,
    ever); later calls reuse it. Stripe sends the browser back to the app when the pro is done
    or the link has expired; then read GET /v1/pros/me/payouts."""
    return await payouts.onboarding_link(user)


@router.get("", response_model=PayoutsOut, summary="My payout status", responses=_RESPONSES)
async def get_payouts_status(
    user: ProUser, payouts: Annotated[PayoutsService, Depends(get_payouts_service)]
) -> PayoutsOut:
    """Where the pro's payout onboarding stands, read from Stripe on each call. Only a pro with
    payouts enabled receives requests."""
    return await payouts.status(user)


_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url={link}">
<title>Jack Fix It</title>
</head>
<body>
<p><a href="{link}">Back to Jack Fix It</a></p>
</body>
</html>
"""
_PAGE_HEADERS = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'",
    "Referrer-Policy": "no-referrer",
}


def _back_to_app(settings: Settings, result: Literal["return", "refresh"]) -> HTMLResponse:
    """Sends the browser to the app's link from settings, never to anything in the request."""
    link = html.escape(f"{settings.payouts_onboarding_app_url}?result={result}", quote=True)
    return HTMLResponse(_PAGE.format(link=link), headers=_PAGE_HEADERS)


@pages_router.get("/return", response_class=HTMLResponse)
async def onboarding_return(
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> HTMLResponse:
    """Stripe's return_url: the pro left onboarding (done or not); the app reads the status."""
    return _back_to_app(settings, "return")


@pages_router.get("/refresh", response_class=HTMLResponse)
async def onboarding_refresh(
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> HTMLResponse:
    """Stripe's refresh_url: the link expired or was used; the app asks for a new one."""
    return _back_to_app(settings, "refresh")
