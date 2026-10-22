from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.errors import ErrorResponse
from app.modules.categories.schemas import CategoryOut
from app.modules.categories.service import CategoryService
from app.rate_limit import limit_per_ip

router = APIRouter(prefix="/categories", tags=["catalog"])

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
    response_model=list[CategoryOut],
    summary="List the categories",
    dependencies=[Depends(limit_per_ip("catalog_categories"))],
    responses=_RATE_LIMITED,
)
async def list_categories(
    session: Annotated[AsyncSession, Depends(get_session)],
) -> list[CategoryOut]:
    """Active categories, by slug. No sign-in needed: the landing page and the request flow
    show them before login."""
    return await CategoryService(session).list_active()
