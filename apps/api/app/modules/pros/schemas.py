import uuid
from datetime import date, datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.modules.addresses.schemas import NO_NUL
from app.modules.categories.schemas import CategorySummary
from app.modules.pros.models import ProDocumentStatus, ProDocumentType, ProVerificationStatus
from app.modules.service_areas.schemas import ServiceAreaOut

MAX_YEARS_OF_EXPERIENCE = 80  # the pro_profiles CHECK


class PhotoOut(BaseModel):
    url: str = Field(description="Presigned GET URL.")
    expires_at: datetime


class ProProfileOut(BaseModel):
    bio: str | None
    years_of_experience: int | None
    photo: PhotoOut | None
    verification_status: ProVerificationStatus
    payouts_enabled: bool
    categories: list[CategorySummary]
    service_areas: list[ServiceAreaOut]


class ProProfileUpdate(BaseModel):
    """Only the fields sent change. Verification, payouts, rating and job count are set by the
    platform: sending them is a 422 (extra="forbid")."""

    model_config = ConfigDict(extra="forbid")

    bio: (
        Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000, pattern=NO_NUL)]
        | None
    ) = Field(default=None, description="An empty string or null clears it.")
    years_of_experience: int | None = Field(default=None, ge=0, le=MAX_YEARS_OF_EXPERIENCE)
    photo_key: str | None = Field(
        default=None,
        description="Key of the caller's own profile_photo upload (POST /v1/uploads); null clears.",
    )
    category_ids: list[uuid.UUID] = Field(
        default_factory=list,
        description="Replaces the set: active categories, no duplicates, up to PRO_MAX_CATEGORIES.",
    )
    service_area_ids: list[uuid.UUID] = Field(
        default_factory=list,
        description=(
            "Replaces the set: active service areas, no duplicates, up to PRO_MAX_SERVICE_AREAS."
        ),
    )


class DocumentSubmission(BaseModel):
    """A pro submits a document; the review fields belong to the admin (#41): sending them is
    a 422 (extra="forbid")."""

    model_config = ConfigDict(extra="forbid")

    doc_type: ProDocumentType
    file_key: str = Field(
        description="Key of the caller's own pro_document upload (POST /v1/uploads)."
    )
    expires_on: date | None = Field(default=None, description="Today or later (UTC date).")


class DocumentOut(BaseModel):
    id: uuid.UUID
    doc_type: ProDocumentType
    status: ProDocumentStatus
    rejection_reason: str | None
    expires_on: date | None
    created_at: datetime
    url: str = Field(description="Presigned GET URL of the file.")
    expires_at: datetime = Field(description="When the URL stops working.")


class DocumentsOut(BaseModel):
    documents: list[DocumentOut] = Field(
        description="The latest document of each type, superseded ones left out."
    )
    history: list[DocumentOut] = Field(
        description="Older reviewed (approved or rejected) documents, newest first."
    )
    required_types: list[ProDocumentType]
    missing_types: list[ProDocumentType] = Field(
        description="Required types with no pending or approved document."
    )
