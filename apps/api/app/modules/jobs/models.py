import uuid
from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Final

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum


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
    __table_args__ = tuple(
        CheckConstraint(f"{column} >= 0", name=f"{column}_non_negative")
        for column in _MONEY_COLUMNS
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
