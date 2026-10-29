import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum


class QuoteStatus(StrEnum):
    """Internal states (docs/glossary.md). Transitions belong to the state machine (#60)."""

    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    EXPIRED = "expired"
    WITHDRAWN = "withdrawn"


class Quote(IdTimestampsMixin, Base):
    __tablename__ = "quotes"
    __table_args__ = (
        # One quote per pro per request. Its index, led by request_id, also serves that key.
        UniqueConstraint("request_id", "pro_id"),
        CheckConstraint("amount_cents > 0", name="amount_cents_positive"),
        CheckConstraint("duration_minutes > 0", name="duration_minutes_positive"),
    )

    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("service_requests.id"))
    pro_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pro_profiles.id"), index=True)
    amount_cents: Mapped[int]
    scope: Mapped[str] = mapped_column(Text)
    # "How I'll do the job" (#246): optional, shown to the customer masked like the scope.
    approach: Mapped[str | None] = mapped_column(Text)
    duration_minutes: Mapped[int]
    proposed_start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[QuoteStatus] = mapped_column(
        str_enum(QuoteStatus, "quote_status"),
        server_default=QuoteStatus.PENDING.value,
        index=True,
    )
