from datetime import datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, DateTime, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum


class WebhookEventStatus(StrEnum):
    # Stored with its payload, queued for the worker.
    PENDING = "pending"
    # Its handler ran and committed.
    PROCESSED = "processed"
    # No handler for its type, or the other mode (test vs live): kept, never handled.
    IGNORED = "ignored"
    # Its handler failed STRIPE_WEBHOOK_MAX_ATTEMPTS times; the payload stays for a reprocess.
    FAILED = "failed"


class WebhookEvent(IdTimestampsMixin, Base):
    """One Stripe event, recorded once by its id (D7.3, #40): a redelivery finds this row instead
    of being handled again. The payload is kept only while the event may still be handled."""

    __tablename__ = "webhook_events"
    __table_args__ = (CheckConstraint("attempts >= 0", name="attempts_non_negative"),)

    stripe_event_id: Mapped[str] = mapped_column(String(255), unique=True)
    event_type: Mapped[str] = mapped_column(String(255))
    livemode: Mapped[bool]
    stripe_created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[WebhookEventStatus] = mapped_column(
        str_enum(WebhookEventStatus, "webhook_event_status")
    )
    # Handler runs that ended, failed or not.
    attempts: Mapped[int] = mapped_column(server_default="0")
    # The class name of the last handler error, never its message.
    last_error: Mapped[str | None] = mapped_column(String(255))
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    payload: Mapped[dict[str, object] | None] = mapped_column(JSONB)
