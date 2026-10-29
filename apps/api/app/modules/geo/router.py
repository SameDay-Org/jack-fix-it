from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.integrations.geocoding import ReverseGeocoder, get_reverse_geocoder
from app.modules.auth.permissions import CustomerUser
from app.modules.geo.schemas import ReverseAddressOut, ReversePositionIn
from app.modules.geo.service import GeoService
from app.modules.service_areas.service import ServiceAreaService
from app.rate_limit import RateLimiter, enforce_limit, get_rate_limiter

router = APIRouter(prefix="/geo", tags=["geo"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_geo_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    geocoder: Annotated[ReverseGeocoder, Depends(get_reverse_geocoder)],
) -> GeoService:
    return GeoService(geocoder, ServiceAreaService(session))


async def limit_geo_reverse(
    user: CustomerUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """GEO_REVERSE_LIMIT lookups per customer per GEO_REVERSE_WINDOW_SECONDS. The key holds
    the user id only, never the position."""
    await enforce_limit(
        limiter,
        "geo_reverse",
        str(user.id),
        limit=settings.geo_reverse_limit,
        window_seconds=settings.geo_reverse_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


_RATE_LIMITED: dict[int | str, dict[str, Any]] = {
    status.HTTP_429_TOO_MANY_REQUESTS: {
        **_error("rate_limited: too many lookups; retry later."),
        "headers": {
            "Retry-After": {
                "description": "Seconds until the current limit window ends.",
                "schema": {"type": "integer"},
            }
        },
    },
}


@router.post(
    "/reverse",
    response_model=ReverseAddressOut,
    summary="The address at a device position",
    dependencies=[Depends(limit_geo_reverse)],
    responses={
        status.HTTP_401_UNAUTHORIZED: _error(
            "invalid_token: missing, invalid or expired access token."
        ),
        status.HTTP_403_FORBIDDEN: _error("forbidden: only customers look up their position."),
        status.HTTP_404_NOT_FOUND: _error(
            "location_not_resolved: no US street address at this position."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: lat must be in [-90, 90] and lng in [-180, 180], both finite "
            "numbers (not strings or booleans), and nothing else in the body."
        ),
        **_RATE_LIMITED,
        status.HTTP_503_SERVICE_UNAVAILABLE: _error(
            "geocoding_unavailable: the geocoding provider is not configured or not reachable."
        ),
    },
)
async def reverse_geocode(
    user: CustomerUser,
    data: ReversePositionIn,
    service: Annotated[GeoService, Depends(get_geo_service)],
) -> ReverseAddressOut:
    """The parts of the US street address at the device position, for the "use my location"
    button of the address book, and whether that ZIP is served. Nothing is stored."""
    return await service.reverse(user.id, data)
