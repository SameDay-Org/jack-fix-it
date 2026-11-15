import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.integrations.storage import Storage, get_storage
from app.middleware import NoStoreRoute
from app.modules.auth.permissions import PanelUser, ProUser
from app.modules.categories.service import CategoryService
from app.modules.pros.documents import ProDocumentService
from app.modules.pros.models import REVIEW_REASON_MAX_LENGTH, ProVerificationStatus
from app.modules.pros.review import ProReviewConfig, ProReviewService
from app.modules.pros.schemas import (
    DocumentOut,
    DocumentsOut,
    DocumentSubmission,
    ProProfileOut,
    ProProfileUpdate,
    ProReviewIn,
    StaffDocumentReviewOut,
    StaffProDecisionOut,
    StaffProOut,
    StaffProPage,
)
from app.modules.pros.service import ProProfileConfig, ProProfileService
from app.modules.service_areas.service import ServiceAreaService

router = APIRouter(prefix="/pros", tags=["pros"])
# The BDC and admins review the pros in the panel (#41). No HTTP cache may keep an answer:
# they carry document URLs and decisions.
staff_router = APIRouter(prefix="/admin/pros", tags=["pros"], route_class=NoStoreRoute)


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


def get_pro_review_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    storage: Annotated[Storage, Depends(get_storage)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> ProReviewService:
    return ProReviewService(
        session,
        CategoryService(session),
        ServiceAreaService(session),
        storage,
        ProReviewConfig.from_settings(settings),
    )


Reviews = Annotated[ProReviewService, Depends(get_pro_review_service)]
_STAFF_ACCESS: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
    status.HTTP_403_FORBIDDEN: _error("forbidden: only agents and admins."),
}
_PRO_NOT_FOUND = _error("pro_not_found: no pro profile with this id.")
_REVIEW_BODY = (
    "validation_error: an unknown decision, rejected without a reason, approved with one, a "
    f"reason empty, blank or longer than {REVIEW_REASON_MAX_LENGTH} characters, another "
    "field, or an id that is not a UUID."
)


@staff_router.get(
    "",
    response_model=StaffProPage,
    summary="List pros by verification status (staff)",
    responses={
        **_STAFF_ACCESS,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: an unknown status, a bad cursor or limit."
        ),
    },
)
async def staff_list_pros(
    user: PanelUser,
    reviews: Reviews,
    status_filter: Annotated[
        ProVerificationStatus,
        Query(alias="status", description="Only pros in this verification status."),
    ] = ProVerificationStatus.PENDING,
    limit: Annotated[int | None, Query(gt=0, description="Page size; capped.")] = None,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
) -> StaffProPage:
    """The pros in one verification status (pending when left out), newest profile first, for
    the BDC and admins: first name and last initial, categories, how many ZIPs they serve and
    their documents by status, plus how many pros each status has. Never an email, a phone, a
    last name or an address."""
    return await reviews.staff_list(status=status_filter, limit=limit, cursor=cursor)


@staff_router.get(
    "/{pro_id}",
    response_model=StaffProOut,
    summary="Read a pro for review (staff)",
    responses={
        **_STAFF_ACCESS,
        status.HTTP_404_NOT_FOUND: _PRO_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: a pro_id that is not a UUID."
        ),
    },
)
async def staff_get_pro(pro_id: uuid.UUID, user: PanelUser, reviews: Reviews) -> StaffProOut:
    """One pro: the profile with the legal name (to match the ID document), the documents with
    short-lived presigned URLs, the types required and missing, and what an approval still
    needs. Every read is recorded in the audit log with the staff member who made it."""
    return await reviews.staff_get(user, pro_id)


@staff_router.post(
    "/{pro_id}/documents/{document_id}/review",
    response_model=StaffDocumentReviewOut,
    summary="Approve or reject a pro's document (staff)",
    responses={
        **_STAFF_ACCESS,
        status.HTTP_404_NOT_FOUND: _error(
            "document_not_found: this pro has no document with this id."
        ),
        status.HTTP_409_CONFLICT: _error(
            "document_not_pending: the document has another decision already, or was replaced "
            "by a newer submission."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(_REVIEW_BODY),
    },
)
async def staff_review_document(
    pro_id: uuid.UUID,
    document_id: uuid.UUID,
    data: ProReviewIn,
    user: PanelUser,
    reviews: Reviews,
) -> StaffDocumentReviewOut:
    """Reviews a pending document. A rejection needs a reason, which the pro reads. The same
    decision again answers the document as first decided and changes nothing. Each review is
    recorded in the audit log with the staff member who made it."""
    return await reviews.review_document(user, pro_id, document_id, data)


@staff_router.post(
    "/{pro_id}/decision",
    response_model=StaffProDecisionOut,
    summary="Approve or reject a pro (staff)",
    responses={
        **_STAFF_ACCESS,
        status.HTTP_404_NOT_FOUND: _PRO_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "pro_not_approvable: an approval while a required document type has no approved, "
            "non-expired document, or the pro has no category or no service area; the message "
            f"lists what is missing. {_REVIEW_BODY}"
        ),
    },
)
async def staff_decide_pro(
    pro_id: uuid.UUID, data: ProReviewIn, user: PanelUser, reviews: Reviews
) -> StaffProDecisionOut:
    """Approves or rejects the profile. Only an approved pro (with payouts enabled) receives
    requests. A rejection needs a reason, which the pro reads in GET /v1/pros/me; a rejected
    pro can be approved later. The same decision again changes nothing. Each decision is
    recorded in the audit log with the staff member who made it."""
    return await reviews.decide(user, pro_id, data)
