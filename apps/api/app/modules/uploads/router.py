from typing import Annotated, Any

from fastapi import APIRouter, Depends, status

from app.config import Settings, get_app_settings
from app.errors import ErrorResponse
from app.integrations.storage import Storage, get_storage
from app.modules.auth.permissions import AppUser
from app.modules.uploads.schemas import (
    DownloadUrlRequest,
    DownloadUrlResponse,
    UploadRequest,
    UploadResponse,
)
from app.modules.uploads.service import UploadConfig, UploadService

router = APIRouter(prefix="/uploads", tags=["uploads"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_upload_service(
    storage: Annotated[Storage, Depends(get_storage)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> UploadService:
    return UploadService(storage, UploadConfig.from_settings(settings))


_UNAUTHORIZED = _error("invalid_token: missing, invalid or expired access token.")


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=UploadResponse,
    summary="Get an upload URL",
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
    return uploads.create_upload(user, data)


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
