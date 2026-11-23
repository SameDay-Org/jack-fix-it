import uuid
from datetime import date, datetime
from enum import StrEnum
from typing import Annotated, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

from app.modules.addresses.schemas import NO_NUL
from app.modules.categories.schemas import CategorySummary
from app.modules.pros.models import (
    REVIEW_REASON_MAX_LENGTH,
    ProDocumentStatus,
    ProDocumentType,
    ProVerificationStatus,
)
from app.modules.service_areas.schemas import ServiceAreaOut
from app.modules.uploads.schemas import PhotoOut
from app.modules.users.schemas import deleted_party
from app.redaction import redact_contacts

MAX_YEARS_OF_EXPERIENCE = 80  # the pro_profiles CHECK


class ProProfileOut(BaseModel):
    bio: str | None
    years_of_experience: int | None
    photo: PhotoOut | None
    verification_status: ProVerificationStatus
    rejection_reason: str | None = Field(
        description=(
            "Why the team rejected the profile, contact details masked; null unless rejected."
        )
    )
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


# --- Staff review (#41) ----------------------------------------------------------------------


def _contacts_masked(value: str) -> str:
    """The reason as the pro will read it: every contact detail app.redaction recognizes (a
    phone, an email, a link, a handle...) masked, as in the chat, so a contact pasted by staff
    never reaches the pro (#406 Vault B1). Only this text goes on: stored, audited, answered
    and compared on a replay; no original is kept. Nothing left once invisible characters are
    dropped, or (in theory) masks past the limit, is a 422."""
    text = redact_contacts(value).text.strip()
    if not text or len(text) > REVIEW_REASON_MAX_LENGTH:
        raise ValueError("a reason needs text once its contact details are masked")
    return text


ReviewReason = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=REVIEW_REASON_MAX_LENGTH, pattern=NO_NUL
    ),
    AfterValidator(_contacts_masked),
]


class ReviewDecision(StrEnum):
    APPROVED = "approved"
    REJECTED = "rejected"


class ProReviewIn(BaseModel):
    """Staff's decision on a document or on a profile."""

    model_config = ConfigDict(extra="forbid")

    decision: ReviewDecision
    reason: ReviewReason | None = Field(
        default=None,
        description=(
            "Why, as plain text the pro reads (contact details are masked): required with"
            " rejected, refused with approved."
        ),
    )

    @model_validator(mode="after")
    def _reason_goes_with_a_rejection(self) -> Self:
        if (self.decision is ReviewDecision.REJECTED) != (self.reason is not None):
            raise ValueError("a reason is required with rejected and refused with approved")
        return self


class StaffDocumentReviewOut(BaseModel):
    """A document as a review answers it: never its file."""

    id: uuid.UUID
    doc_type: ProDocumentType
    status: ProDocumentStatus
    rejection_reason: str | None
    expires_on: date | None
    created_at: datetime
    reviewed_at: datetime | None


class StaffDocumentOut(StaffDocumentReviewOut):
    url: str = Field(description="Presigned GET URL of the file; short-lived.")
    expires_at: datetime = Field(description="When the URL stops working.")


class StaffDocumentCounts(BaseModel):
    """A pro's documents by status, superseded ones left out."""

    pending: int
    approved: int
    rejected: int


class StaffProItem(BaseModel):
    """A pro in the staff list: no email, phone, last name or address."""

    id: uuid.UUID = Field(description="The pro profile's id.")
    name: str | None = Field(
        description='First name and last initial ("María P."); null when a name is missing or '
        "shows a contact detail."
    )
    pro_deleted: bool = deleted_party("pro")
    verification_status: ProVerificationStatus
    payouts_enabled: bool
    categories: list[CategorySummary]
    zip_count: int = Field(description="How many ZIPs the pro serves.")
    documents: StaffDocumentCounts
    submitted_at: datetime | None = Field(
        description="When the oldest document still pending was submitted; null with none."
    )
    created_at: datetime


class StaffProStatusCounts(BaseModel):
    """Every pro profile by verification status."""

    pending: int
    approved: int
    rejected: int


class StaffProPage(BaseModel):
    items: list[StaffProItem] = Field(description="Newest profile first.")
    next_cursor: str | None = Field(description="Pass as `cursor` for older profiles.")
    counts: StaffProStatusCounts


class ApprovalBlockerKind(StrEnum):
    # A required type has no approved document.
    DOCUMENT_MISSING = "document_missing"
    # Every approved document of a required type has expired.
    DOCUMENT_EXPIRED = "document_expired"
    NO_CATEGORY = "no_category"
    NO_SERVICE_AREA = "no_service_area"


class ApprovalBlocker(BaseModel):
    kind: ApprovalBlockerKind
    doc_type: ProDocumentType | None = Field(description="Set for the two document kinds.")


class StaffProDecisionOut(BaseModel):
    """A profile as a decision answers it."""

    id: uuid.UUID
    verification_status: ProVerificationStatus
    rejection_reason: str | None
    reviewed_at: datetime | None


class StaffProOut(StaffProDecisionOut):
    user_id: uuid.UUID
    name: str | None = Field(description='First name and last initial ("María P.").')
    legal_name: str | None = Field(
        description="First and last name as on the account, to match the ID document; null "
        "when the account has neither. Only this detail carries it, never the list."
    )
    pro_deleted: bool = deleted_party("pro")
    payouts_enabled: bool
    bio: str | None = Field(description="As the pro wrote it: it may hold contact details.")
    years_of_experience: int | None
    photo: PhotoOut | None
    categories: list[CategorySummary]
    service_areas: list[ServiceAreaOut]
    documents: list[StaffDocumentOut] = Field(
        description="The latest document of each type, superseded ones left out."
    )
    history: list[StaffDocumentOut] = Field(
        description="Older reviewed (approved or rejected) documents, newest first."
    )
    required_types: list[ProDocumentType]
    missing_types: list[ProDocumentType] = Field(
        description="Required types with no pending or approved document."
    )
    approval_blockers: list[ApprovalBlocker] = Field(
        description="What an approval still needs; empty when the pro can be approved."
    )
    created_at: datetime
