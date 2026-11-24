from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, status
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.integrations.storage import Storage, get_storage
from app.modules.auth.permissions import AppUser
from app.modules.uploads.pending import PendingUploads, RedisUploadGrants, UploadGrants
from app.modules.uploads.schemas import (
    DownloadUrlRequest,
    DownloadUrlResponse,
    UploadRequest,
    UploadResponse,
)
from app.modules.uploads.service import UploadConfig, UploadService
from app.rate_limit import RateLimiter, enforce_limit, get_rate_limiter

router = APIRouter(prefix="/uploads", tags=["uploads"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_upload_grants(
    request: Request, settings: Annotated[Settings, Depends(get_app_settings)]
) -> UploadGrants:
    """The issued, not yet landed upload URLs (#529), in the app's Redis."""
    redis: Redis = request.app.state.redis
    return RedisUploadGrants(
        redis,
        ttl_seconds=settings.upload_url_ttl_seconds,
        grace_seconds=settings.upload_grant_grace_seconds,
        max_bytes=settings.upload_pending_max_bytes,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


def get_upload_service(
    storage: Annotated[Storage, Depends(get_storage)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    session: Annotated[AsyncSession, Depends(get_session)],
    grants: Annotated[UploadGrants, Depends(get_upload_grants)],
) -> UploadService:
    return UploadService(
        storage,
        UploadConfig.from_settings(settings),
        PendingUploads(
            session,
            storage,
            grants,
            list_timeout_seconds=settings.upload_pending_list_timeout_seconds,
        ),
    )


_UNAUTHORIZED = _error("invalid_token: missing, invalid or expired access token.")


async def limit_upload_urls(
    user: AppUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """UPLOAD_URL_LIMIT upload URLs per user per UPLOAD_URL_WINDOW_SECONDS (#529): each one
    lets its caller store up to the purpose's largest size."""
    await enforce_limit(
        limiter,
        "upload_url",
        str(user.id),
        limit=settings.upload_url_limit,
        window_seconds=settings.upload_url_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=UploadResponse,
    summary="Get an upload URL",
    dependencies=[Depends(limit_upload_urls)],
    responses={
        status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN: _error(
            "forbidden: not a customer or pro (agents and admins upload nothing); "
            "upload_forbidden: the caller's role cannot upload for this purpose."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "upload_invalid: content type not allowed for the purpose, or size out of range; "
            "validation_error: malformed body."
        ),
        status.HTTP_413_CONTENT_TOO_LARGE: _error(
            "pending_uploads_too_large: this upload would put the account's uploads that "
            "nothing uses yet over UPLOAD_PENDING_MAX_BYTES; use them, or wait for unused ones "
            "to clear (a day)."
        ),
        status.HTTP_503_SERVICE_UNAVAILABLE: _error(
            "uploads_unavailable: the account's pending uploads could not be counted; retry."
        ),
        status.HTTP_429_TOO_MANY_REQUESTS: {
            **_error("rate_limited: too many upload URLs for this account; retry later."),
            "headers": {
                "Retry-After": {
                    "description": "Seconds until the current limit window ends.",
                    "schema": {"type": "integer"},
                }
            },
        },
    },
)
async def create_upload(
    data: UploadRequest,
    user: AppUser,
    uploads: Annotated[UploadService, Depends(get_upload_service)],
) -> UploadResponse:
    """A short-lived presigned PUT URL for one file of the declared type and exact size.

    PUT the file to `upload_url` with exactly the returned `headers`: Content-Type and
    Content-Length are signed, so any other type or size is rejected by the storage. Keep
    `key` to attach the file to a request, job or profile.
    """
    return await uploads.create_upload(user, data)


@router.post(
    "/download-url",
    response_model=DownloadUrlResponse,
    summary="Get a download URL",
    responses={
        status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN: _error("forbidden: not a customer or pro."),
        status.HTTP_404_NOT_FOUND: _error("upload_not_found: not a file of the caller."),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error("upload_invalid: malformed key."),
    },
)
async def create_download_url(
    data: DownloadUrlRequest,
    user: AppUser,
    uploads: Annotated[UploadService, Depends(get_upload_service)],
) -> DownloadUrlResponse:
    """A short-lived presigned GET URL for one of the caller's own files."""
    return uploads.create_download_url(user, data.key)
