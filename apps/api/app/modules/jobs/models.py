import uuid
from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Final

from sqlalchemy import CHAR, CheckConstraint, DateTime, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum
from app.modules.media.safe_status import MediaSafeStatus


class JobStatus(StrEnum):
    """Internal states (docs/glossary.md). Transitions belong to the state machine (#60).

    A job is created when the payment succeeds, so there is no unpaid state.
    """

    SCHEDULED = "scheduled"
    ON_THE_WAY = "on_the_way"
    IN_PROGRESS = "in_progress"
    # Done by the pro; the customer's 48 h confirmation window is open.
    COMPLETED = "completed"
    # Confirmed by the customer, or automatically after 48 h; the transfer is pending.
    CONFIRMED = "confirmed"
    # The transfer to the pro was created (after a full or partial release).
    PAID_OUT = "paid_out"
    DISPUTED = "disputed"
    # Fully refunded.
    REFUNDED = "refunded"
    CANCELLED = "cancelled"


# Frozen at payment. No CHECK ties them together: who absorbs Stripe fees is pending (#2).
_MONEY_COLUMNS: Final = (
    "customer_price_cents",
    "pro_payout_cents",
    "platform_fee_cents",
    "tax_cents",
)


class Job(IdTimestampsMixin, Base):
    __tablename__ = "jobs"
    __table_args__ = (
        *(
            CheckConstraint(f"{column} >= 0", name=f"{column}_non_negative")
            for column in _MONEY_COLUMNS
        ),
        CheckConstraint("arrival_code ~ '^[0-9]{4}$'", name="arrival_code_four_digits"),
        CheckConstraint("arrival_code_attempts >= 0", name="arrival_code_attempts_non_negative"),
    )

    # One job per request and per quote; the unique indexes also serve the foreign keys.
    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("service_requests.id"), unique=True)
    quote_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("quotes.id"), unique=True)
    customer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    pro_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pro_profiles.id"), index=True)
    status: Mapped[JobStatus] = mapped_column(
        str_enum(JobStatus, "job_status"), server_default=JobStatus.SCHEDULED.value, index=True
    )
    customer_price_cents: Mapped[int]
    pro_payout_cents: Mapped[int]
    platform_fee_cents: Mapped[int]
    tax_cents: Mapped[int]
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Job execution (D12.2, #63). Set by the pro's "On my way": when they expect to arrive.
    eta_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The 4-digit code the customer reads to the pro at check-in: issued at "On my way" and
    # cleared at check-in. Never logged, never shown to the pro.
    arrival_code: Mapped[str | None] = mapped_column(CHAR(4))
    # Wrong codes entered since the code was issued; the limit locks it (arrival_code_locked_at).
    arrival_code_attempts: Mapped[int] = mapped_column(server_default="0")
    arrival_code_locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The check-in (Arrived): the right code was entered. Its location is on the job event.
    checked_in_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class JobEvent(IdTimestampsMixin, Base):
    """Append-only history of a job. Written by the state machine (#60), never updated."""

    __tablename__ = "job_events"

    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id"), index=True)
    # No CHECK: event types grow with the state machine (#60) and check-in (#63).
    type: Mapped[str] = mapped_column(String(64))
    # Set only by status changes. Each column has its own CHECK name.
    from_status: Mapped[JobStatus | None] = mapped_column(str_enum(JobStatus, "from_job_status"))
    to_status: Mapped[JobStatus | None] = mapped_column(str_enum(JobStatus, "to_job_status"))
    # NULL for the system, e.g. the 48 h auto-confirm.
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), index=True)
    lat: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    lng: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))


class JobPhotoKind(StrEnum):
    BEFORE = "before"
    AFTER = "after"


class JobPhoto(IdTimestampsMixin, Base):
    """A photo the pro took of the work (#298): before it, and after it (Job's done needs one)."""

    __tablename__ = "job_photos"

    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id"), index=True)
    kind: Mapped[JobPhotoKind] = mapped_column(str_enum(JobPhotoKind, "job_photo_kind"))
    # The pro's job_photo upload (u/<user_id>/job_photo/...); one file belongs to one job.
    file_key: Mapped[str] = mapped_column(String(256), unique=True)
    uploaded_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    # The privacy-safe copy the worker makes, as for request media (#173): metadata stripped,
    # under an opaque key (m/<32 hex><ext>). Only it is ever shown to the customer.
    safe_key: Mapped[str | None] = mapped_column(String(256), unique=True)
    safe_status: Mapped[MediaSafeStatus] = mapped_column(
        str_enum(MediaSafeStatus, "media_safe_status"),
        server_default=MediaSafeStatus.PENDING.value,
    )
    safe_content_type: Mapped[str | None] = mapped_column(String(64))
