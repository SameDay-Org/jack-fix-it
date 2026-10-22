import uuid
from decimal import Decimal
from enum import StrEnum

from sqlalchemy import CheckConstraint, ForeignKey, Numeric, String, Text, UniqueConstraint, false
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
