import uuid
from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    false,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum


class ProVerificationStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class ProProfile(IdTimestampsMixin, Base):
    """Only an approved profile with payouts_enabled receives requests."""

    __tablename__ = "pro_profiles"
    __table_args__ = (
        CheckConstraint("jobs_count >= 0", name="jobs_count_non_negative"),
        CheckConstraint("years_of_experience BETWEEN 0 AND 80", name="years_of_experience_range"),
    )

    # One profile per user; the unique constraint's index also serves the foreign key.
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), unique=True)
    bio: Mapped[str | None] = mapped_column(Text)
    years_of_experience: Mapped[int | None]
    # A storage key, never a URL.
    photo_key: Mapped[str | None] = mapped_column(String(512))
    verification_status: Mapped[ProVerificationStatus] = mapped_column(
        str_enum(ProVerificationStatus, "pro_verification_status"),
        server_default=ProVerificationStatus.PENDING.value,
        index=True,
    )
    stripe_account_id: Mapped[str | None] = mapped_column(String(255), unique=True)
    # When the account's create was attempted (#39), committed before the call: a create whose
    # answer was lost long ago is looked up in Stripe before another one.
    stripe_account_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    payouts_enabled: Mapped[bool] = mapped_column(server_default=false())
    # A rating, not money; NULL until the first review.
    rating_avg: Mapped[Decimal | None] = mapped_column(Numeric(3, 2))
    jobs_count: Mapped[int] = mapped_column(server_default="0")


class ProCategory(IdTimestampsMixin, Base):
    """A category a pro works in (N:N)."""

    __tablename__ = "pro_categories"
    __table_args__ = (UniqueConstraint("pro_id", "category_id"),)

    pro_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pro_profiles.id"), index=True)
    category_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("categories.id"), index=True)


class ProServiceArea(IdTimestampsMixin, Base):
    """A served ZIP a pro covers (N:N)."""

    __tablename__ = "pro_service_areas"
    __table_args__ = (UniqueConstraint("pro_id", "service_area_id"),)

    pro_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pro_profiles.id"), index=True)
    service_area_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("service_areas.id"), index=True)


class ProDocumentType(StrEnum):
    ID = "id"
    LICENSE = "license"
    INSURANCE = "insurance"


class ProDocumentStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    # Replaced by a newer submission of the same type before review.
    SUPERSEDED = "superseded"


class ProDocument(IdTimestampsMixin, Base):
    """A verification document a pro submits (D6.3, #37); the admin reviews it (#41)."""

    __tablename__ = "pro_documents"
    __table_args__ = (Index("ix_pro_documents_pro_id_doc_type", "pro_id", "doc_type"),)

    pro_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pro_profiles.id"), index=True)
    doc_type: Mapped[ProDocumentType] = mapped_column(
        str_enum(ProDocumentType, "pro_document_type")
    )
    # A storage key, never a URL; one uploaded file is one document.
    file_key: Mapped[str] = mapped_column(String(256), unique=True)
    status: Mapped[ProDocumentStatus] = mapped_column(
        str_enum(ProDocumentStatus, "pro_document_status"),
        server_default=ProDocumentStatus.PENDING.value,
        index=True,
    )
    rejection_reason: Mapped[str | None] = mapped_column(Text)
    expires_on: Mapped[date | None] = mapped_column(Date)
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), index=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
