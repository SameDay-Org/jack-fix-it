import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.integrations.storage import Storage, get_storage
from app.modules.addresses.service import AddressService
from app.modules.auth.permissions import CustomerUser
from app.modules.categories.service import CategoryService
from app.modules.requests.schemas import RequestCreate, RequestOut, RequestPage
from app.modules.requests.service import RequestConfig, ServiceRequestService
from app.modules.service_areas.service import ServiceAreaService
from app.rate_limit import RateLimiter, enforce_limit, get_rate_limiter

router = APIRouter(prefix="/requests", tags=["requests"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_request_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    storage: Annotated[Storage, Depends(get_storage)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> ServiceRequestService:
    return ServiceRequestService(
        session,
        AddressService(session),
        CategoryService(session),
        ServiceAreaService(session),
        storage,
        RequestConfig.from_settings(settings),
    )


async def limit_request_create(
    user: CustomerUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """REQUEST_CREATE_LIMIT requests per customer per REQUEST_CREATE_WINDOW_SECONDS."""
    await enforce_limit(
        limiter,
        "request_create",
        str(user.id),
        limit=settings.request_create_limit,
        window_seconds=settings.request_create_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


_UNAUTHORIZED = _error("invalid_token: missing, invalid or expired access token.")
_FORBIDDEN = _error("forbidden: only customers have service requests.")
_RATE_LIMITED: dict[int | str, dict[str, Any]] = {
    status.HTTP_429_TOO_MANY_REQUESTS: {
        **_error("rate_limited: too many requests created; retry later."),
        "headers": {
            "Retry-After": {
                "description": "Seconds until the current limit window ends.",
                "schema": {"type": "integer"},
            }
        },
    },
}


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=RequestOut,
    summary="Create a service request",
    dependencies=[Depends(limit_request_create)],
    responses={
        status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN: _FORBIDDEN,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "zip_not_served: the address ZIP is outside the active service areas (offer the "
            "waitlist); invalid_category: unknown or inactive category; invalid_media: a media "
            "key that is not the caller's own request_media upload, a duplicate, a key already "
            "used, or too many; validation_error: any other invalid field (past date, intake "
            "answers too large, address format, unknown fields such as urgency)."
        ),
        **_RATE_LIMITED,
    },
)
async def create_request(
    data: RequestCreate,
    user: CustomerUser,
    requests: Annotated[ServiceRequestService, Depends(get_request_service)],
) -> RequestOut:
    """Creates a request for the signed-in customer, with a new service address and media.

    Attach photos and videos by uploading them first (POST /v1/uploads, purpose
    request_media) and listing their keys. The server sets the origin (app), the language
    (the account's) and the status (received).
    """
    return await requests.create(user, data)


@router.get(
    "",
    response_model=RequestPage,
    summary="List my service requests",
    responses={status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED, status.HTTP_403_FORBIDDEN: _FORBIDDEN},
)
async def list_requests(
    user: CustomerUser,
    requests: Annotated[ServiceRequestService, Depends(get_request_service)],
    limit: Annotated[int | None, Query(ge=1, description="Capped at the server's maximum.")] = None,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
) -> RequestPage:
    """The caller's own requests, newest first, in pages."""
    return await requests.list_own(user, limit, cursor)


@router.get(
    "/{request_id}",
    response_model=RequestOut,
    summary="Get one of my service requests",
    responses={
        status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN: _FORBIDDEN,
        status.HTTP_404_NOT_FOUND: _error("not_found: no request of the caller with this id."),
    },
)
async def get_request(
    request_id: uuid.UUID,
    user: CustomerUser,
    requests: Annotated[ServiceRequestService, Depends(get_request_service)],
) -> RequestOut:
    """One of the caller's requests, with presigned URLs for its media."""
    return await requests.get(user, request_id)
