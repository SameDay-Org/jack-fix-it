from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.integrations.storage import Storage, get_storage
from app.modules.auth.permissions import ProUser
from app.modules.categories.service import CategoryService
from app.modules.pros.documents import ProDocumentService
from app.modules.pros.schemas import (
    DocumentOut,
    DocumentsOut,
    DocumentSubmission,
    ProProfileOut,
    ProProfileUpdate,
)
from app.modules.pros.service import ProProfileConfig, ProProfileService
from app.modules.service_areas.service import ServiceAreaService

router = APIRouter(prefix="/pros", tags=["pros"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_pro_profile_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    storage: Annotated[Storage, Depends(get_storage)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> ProProfileService:
    return ProProfileService(
        session,
        CategoryService(session),
        ServiceAreaService(session),
        storage,
        ProProfileConfig.from_settings(settings),
    )


_ACCESS: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
    status.HTTP_403_FORBIDDEN: _error("forbidden: only pros have a pro profile."),
}


@router.get("/me", response_model=ProProfileOut, summary="Get my pro profile", responses=_ACCESS)
async def get_my_profile(
    user: ProUser, profiles: Annotated[ProProfileService, Depends(get_pro_profile_service)]
) -> ProProfileOut:
    """The caller's own profile, with a presigned URL for the photo. The first call creates an
    empty profile, pending verification."""
    return await profiles.get_own(user)


@router.patch(
    "/me",
    response_model=ProProfileOut,
    summary="Edit my pro profile",
    responses={
        **_ACCESS,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "invalid_media: photo_key is not the caller's own profile_photo upload; "
            "invalid_category / invalid_service_area: an unknown or inactive id; "
            "validation_error: any other invalid field (duplicates or too many ids, bio length, "
            "years out of range, fields the platform sets such as verification_status)."
        ),
    },
)
async def update_my_profile(
    data: ProProfileUpdate,
    user: ProUser,
    profiles: Annotated[ProProfileService, Depends(get_pro_profile_service)],
) -> ProProfileOut:
    """Changes only the fields sent, in one transaction. category_ids and service_area_ids
    replace the whole set. Upload the photo first (POST /v1/uploads, purpose profile_photo)."""
    return await profiles.update_own(user, data)


def get_document_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    storage: Annotated[Storage, Depends(get_storage)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> ProDocumentService:
    return ProDocumentService(
        session, CategoryService(session), storage, settings.download_url_ttl_seconds
    )


@router.post(
    "/me/documents",
    status_code=status.HTTP_201_CREATED,
    response_model=DocumentOut,
    summary="Submit a verification document",
    responses={
        **_ACCESS,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "invalid_media: file_key is not the caller's own pro_document upload, or is "
            "already a document; validation_error: an unknown type, an expiry date in the "
            "past, or a field the review sets (status, rejection_reason, reviewed_by...)."
        ),
    },
)
async def submit_document(
    data: DocumentSubmission,
    user: ProUser,
    documents: Annotated[ProDocumentService, Depends(get_document_service)],
) -> DocumentOut:
    """Submits a photo ID, insurance or license for review. Upload the file first
    (POST /v1/uploads, purpose pro_document). A pending document of the same type is replaced
    (superseded); reviewed ones stay as history."""
    return await documents.submit(user, data)


@router.get(
    "/me/documents",
    response_model=DocumentsOut,
    summary="My verification documents",
    responses=_ACCESS,
)
async def list_my_documents(
    user: ProUser,
    documents: Annotated[ProDocumentService, Depends(get_document_service)],
) -> DocumentsOut:
    """The latest document of each type with presigned URLs, older reviewed ones, the types
    required (ID and insurance; a license when one of the pro's categories requires it) and
    the ones still missing."""
    return await documents.list_own(user)
