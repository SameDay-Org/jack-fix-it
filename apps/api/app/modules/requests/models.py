import uuid
from datetime import date, datetime
from enum import StrEnum
from typing import Final

from pydantic import JsonValue
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum

# Shared with the job photos' safe copies (#298); this module's importers keep this name.
from app.modules.media.safe_status import MediaSafeStatus as MediaSafeStatus

# JF- plus the sequence number, zero-padded to at least 6 digits and never truncated:
# lpad() would cut 1234567 to 123456, so to_char with 13 digit positions (the sequence's
# maximum), the last 6 forced. The migration creates the sequence.
PUBLIC_CODE_SEQUENCE: Final = "service_request_code_seq"
PUBLIC_CODE_DEFAULT: Final = (
    f"'JF-' || to_char(nextval('{PUBLIC_CODE_SEQUENCE}'::regclass), 'FM9999999000000')"
)
# One request per customer and Idempotency-Key (#264): the index decides between two creates
# racing with the same key. Keys are per customer, so another customer's never collides.
IDEMPOTENCY_KEY_INDEX: Final = "uq_service_requests_customer_id_idempotency_key"


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


class PreferredPeriod(StrEnum):
    """When in the preferred day the customer would like the visit (#237). Pros propose the
    exact start in their quote; the period only refines a preferred date."""

    MORNING = "morning"
    AFTERNOON = "afternoon"
    EVENING = "evening"
    FLEXIBLE = "flexible"


class ServiceRequest(IdTimestampsMixin, Base):
    __tablename__ = "service_requests"
    __table_args__ = (
        # Without a date the customer is flexible, stored as NULL: a period refines a date.
        CheckConstraint(
            "preferred_period IS NULL OR preferred_date IS NOT NULL",
            name="preferred_period_needs_date",
        ),
        Index(
            IDEMPOTENCY_KEY_INDEX,
            "customer_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
    )

    # Shown to customers and the BDC (e.g. JF-000124); the id stays internal.
    public_code: Mapped[str] = mapped_column(
        String(16), unique=True, server_default=text(PUBLIC_CODE_DEFAULT)
    )
    customer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    # NULL until the BDC classifies a request the customer could not place in a category.
    category_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("categories.id"), index=True)
    address_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("addresses.id"), index=True)
    description: Mapped[str] = mapped_column(Text)
    intake_answers: Mapped[dict[str, JsonValue]] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb")
    )
    # No CHECK yet: their values are defined, and validated, by the request flow (#42).
    urgency: Mapped[str | None] = mapped_column(String(32))
    preferred_contact: Mapped[str | None] = mapped_column(String(32))
    preferred_date: Mapped[date | None]
    # Set whenever preferred_date is (flexible by default); NULL without a date.
    preferred_period: Mapped[PreferredPeriod | None] = mapped_column(
        str_enum(PreferredPeriod, "preferred_period")
    )
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
    # The create's Idempotency-Key (#264), NULL without one, and the SHA-256 (hex) of the body
    # it came with, so a retry with another body is refused. A key older than the window stays
    # here until the same customer sends it again, which clears it from this request.
    idempotency_key: Mapped[uuid.UUID | None]
    idempotency_fingerprint: Mapped[str | None] = mapped_column(String(64))


class RequestMediaKind(StrEnum):
    PHOTO = "photo"
    VIDEO = "video"


class RequestMedia(IdTimestampsMixin, Base):
    """A photo or video the customer uploaded (#35) and attached to a request."""

    __tablename__ = "request_media"

    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("service_requests.id"), index=True)
    kind: Mapped[RequestMediaKind] = mapped_column(str_enum(RequestMediaKind, "request_media_kind"))
    # The storage key (u/<user_id>/request_media/...); one file belongs to one request.
    file_key: Mapped[str] = mapped_column(String(256), unique=True)
    # The privacy-safe copy the worker makes (#173): metadata stripped (EXIF, GPS, XMP, video
    # tags), under an opaque key (m/<32 hex><ext>) with no user id. Only it is ever shown to a
    # pro (part 2); the customer's own views keep the original.
    safe_key: Mapped[str | None] = mapped_column(String(256), unique=True)
    safe_status: Mapped[MediaSafeStatus] = mapped_column(
        str_enum(MediaSafeStatus, "media_safe_status"),
        server_default=MediaSafeStatus.PENDING.value,
        index=True,
    )
    safe_content_type: Mapped[str | None] = mapped_column(String(64))
