from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.errors import ErrorResponse
from app.modules.service_areas.schemas import ZIP_INPUT_PATTERN, RegionOut, ServedCheckOut
from app.modules.service_areas.service import ServiceAreaService
from app.rate_limit import limit_per_ip

router = APIRouter(prefix="/service-areas", tags=["catalog"])

_RATE_LIMITED: dict[int | str, dict[str, Any]] = {
    status.HTTP_429_TOO_MANY_REQUESTS: {
        "model": ErrorResponse,
        "description": "rate_limited: too many requests from this client; retry later.",
        "headers": {
            "Retry-After": {
                "description": "Seconds until the current limit window ends.",
                "schema": {"type": "integer"},
            }
        },
    },
}


@router.get(
    "",
    response_model=list[RegionOut],
    summary="List the served areas",
    dependencies=[Depends(limit_per_ip("catalog_service_areas"))],
    responses=_RATE_LIMITED,
)
async def list_service_areas(
    session: Annotated[AsyncSession, Depends(get_session)],
) -> list[RegionOut]:
    """Active service areas, grouped by region, then city, then ZIP. No sign-in needed: the
    landing page and the request flow show them before login."""
    return await ServiceAreaService(session).active_grouped()


@router.get(
    "/check",
    response_model=ServedCheckOut,
    summary="Is this ZIP served?",
    dependencies=[Depends(limit_per_ip("catalog_zip_check"))],
    responses={
        status.HTTP_422_UNPROCESSABLE_CONTENT: {
            "model": ErrorResponse,
            "description": "validation_error: not a 5-digit ZIP or ZIP+4.",
        },
        **_RATE_LIMITED,
    },
)
async def check_zip(
    session: Annotated[AsyncSession, Depends(get_session)],
    zip_code: Annotated[str, Query(alias="zip", pattern=ZIP_INPUT_PATTERN)],
) -> ServedCheckOut:
    """Whether an active service area covers the ZIP. ZIP+4 is checked by its 5-digit ZIP.
    No sign-in needed: the request flow and the landing page ask before login, and offer the
    waitlist when the answer is no."""
    return await ServiceAreaService(session).check(zip_code)
