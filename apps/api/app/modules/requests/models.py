import uuid
from datetime import date, datetime
from enum import StrEnum
from typing import Final

from sqlalchemy import DateTime, ForeignKey, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum

# JF- plus the sequence number, zero-padded to at least 6 digits and never truncated:
# lpad() would cut 1234567 to 123456, so to_char with 13 digit positions (the sequence's
# maximum), the last 6 forced. The migration creates the sequence.
PUBLIC_CODE_SEQUENCE: Final = "service_request_code_seq"
PUBLIC_CODE_DEFAULT: Final = (
    f"'JF-' || to_char(nextval('{PUBLIC_CODE_SEQUENCE}'::regclass), 'FM9999999000000')"
)


class RequestStatus(StrEnum):
    """Internal states (docs/glossary.md). Transitions belong to the state machine (#60)."""

    RECEIVED = "received"
    REVIEWING = "reviewing"
    FINDING_PRO = "finding_pro"
    QUOTE_READY = "quote_ready"
    ACCEPTED = "accepted"
    EXPIRED = "expired"
    CANCELLED = "cancelled"


class RequestOrigin(StrEnum):
    APP = "app"
    WEB = "web"
    PHONE = "phone"


class ServiceRequest(IdTimestampsMixin, Base):
    __tablename__ = "service_requests"

    # Shown to customers and the BDC (e.g. JF-000124); the id stays internal.
    public_code: Mapped[str] = mapped_column(
        String(16), unique=True, server_default=text(PUBLIC_CODE_DEFAULT)
    )
    customer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    # NULL until the BDC classifies a request the customer could not place in a category.
    category_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("categories.id"), index=True)
    address_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("addresses.id"), index=True)
    description: Mapped[str] = mapped_column(Text)
    intake_answers: Mapped[dict[str, object]] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb")
    )
    # No CHECK yet: their values are defined, and validated, by the request flow (#42).
    urgency: Mapped[str | None] = mapped_column(String(32))
    preferred_contact: Mapped[str | None] = mapped_column(String(32))
    preferred_date: Mapped[date | None]
    language: Mapped[str] = mapped_column(String(8), server_default="en")
    status: Mapped[RequestStatus] = mapped_column(
        str_enum(RequestStatus, "request_status"),
        server_default=RequestStatus.RECEIVED.value,
        index=True,
    )
    assigned_agent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), index=True)
    next_action: Mapped[str | None] = mapped_column(Text)
    first_contact_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_contact_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    origin: Mapped[RequestOrigin] = mapped_column(str_enum(RequestOrigin, "request_origin"))
    utm: Mapped[dict[str, str] | None] = mapped_column(JSONB)
