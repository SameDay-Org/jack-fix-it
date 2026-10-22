from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.errors import ErrorResponse
from app.modules.service_areas.schemas import RegionOut
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
