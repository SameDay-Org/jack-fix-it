import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.modules.auth.permissions import ProUser
from app.modules.dispatch.opportunities import OpportunityConfig, OpportunityService
from app.modules.dispatch.schemas import OpportunityDetail, OpportunityPage

router = APIRouter(prefix="/pros/me/opportunities", tags=["pros"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_opportunity_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> OpportunityService:
    return OpportunityService(session, OpportunityConfig.from_settings(settings))


_ACCESS: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
    status.HTTP_403_FORBIDDEN: _error("forbidden: only pros have opportunities."),
}


@router.get(
    "",
    response_model=OpportunityPage,
    summary="List my opportunities",
    responses={
        **_ACCESS,
        status.HTTP_404_NOT_FOUND: _error(
            "not_found: the caller has no pro profile yet (GET /v1/pros/me creates it)."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error("validation_error: a malformed cursor."),
    },
)
async def list_opportunities(
    user: ProUser,
    opportunities: Annotated[OpportunityService, Depends(get_opportunity_service)],
    limit: Annotated[int | None, Query(ge=1, description="Capped at the server's maximum.")] = None,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
) -> OpportunityPage:
    """The requests dispatched to the caller that they can still quote on, newest first, in
    pages. The location is the ZIP and city only; the customer is never shown."""
    return await opportunities.list_own(user, limit, cursor)


@router.get(
    "/{dispatch_id}",
    response_model=OpportunityDetail,
    summary="Open one of my opportunities",
    responses={
        **_ACCESS,
        status.HTTP_404_NOT_FOUND: _error(
            "not_found: no open opportunity of the caller with this id (another pro's, "
            "declined, expired, or the request is closed)."
        ),
    },
)
async def open_opportunity(
    dispatch_id: uuid.UUID,
    user: ProUser,
    opportunities: Annotated[OpportunityService, Depends(get_opportunity_service)],
) -> OpportunityDetail:
    """The full request, without its photos for now (sanitized copies come with #173). The
    first open records that the pro saw it (viewed, viewed_at); opening it again changes
    nothing."""
    return await opportunities.open_own(user, dispatch_id)
