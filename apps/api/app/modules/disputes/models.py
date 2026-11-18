import uuid
from datetime import datetime
from enum import StrEnum
from typing import Final

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum
from app.modules.media.safe_status import MediaSafeStatus

# The longest text a side writes (the customer's description, the pro's reply), in characters,
# as stored: redacted and trimmed.
TEXT_MAX_LENGTH: Final = 2000
# One dispute per job. The name is the naming convention's (its first column).
ONE_PER_JOB: Final = "uq_disputes_job_id"
# One dispute per customer and Idempotency-Key: a key never makes a second report.
IDEMPOTENCY_KEY_INDEX: Final = "uq_disputes_opened_by_idempotency_key"


class DisputeReason(StrEnum):
    """What the customer says went wrong (#75)."""

    WORK_INCOMPLETE = "work_incomplete"
    POOR_QUALITY = "poor_quality"
    NO_SHOW = "no_show"
    DAMAGE = "damage"
    OTHER = "other"


class DisputeStatus(StrEnum):
    OPEN = "open"
    RESOLVED = "resolved"


class DisputeResolution(StrEnum):
    """How an admin settles a dispute (#76)."""

    RELEASED = "released"
    PARTIAL_RELEASE = "partial_release"
    REFUNDED = "refunded"


# Resolutions that pay the pro (all or part of their payout): the job's transfer follows.
RELEASES: Final = frozenset({DisputeResolution.RELEASED, DisputeResolution.PARTIAL_RELEASE})
# The longest note an admin writes on a resolution, in characters (#76).
NOTE_MAX_LENGTH: Final = 1000


class Dispute(IdTimestampsMixin, Base):
    """A problem the customer reported with a completed job, inside its confirmation window
    (#75): at most one per job. While it is open the job is disputed and its money is held
    (payments.transfers.has_open_hold); an admin resolves it (#76).

    `description` and `pro_reply` are each side's text after the contact redaction
    (app.redaction), the only form ever stored, and never logged. The resolution columns stay
    NULL until #76 resolves the dispute.
    """

    __tablename__ = "disputes"
    __table_args__ = (
        CheckConstraint(
            f"char_length(description) BETWEEN 1 AND {TEXT_MAX_LENGTH}",
            name="description_length",
        ),
        CheckConstraint(
            f"pro_reply IS NULL OR char_length(pro_reply) BETWEEN 1 AND {TEXT_MAX_LENGTH}",
            name="pro_reply_length",
        ),
        CheckConstraint(
            "(pro_reply IS NULL) = (pro_replied_at IS NULL)", name="pro_reply_has_time"
        ),
        # Open: nothing of a resolution yet. Resolved: how, by whom and when.
        CheckConstraint(
            "(status = 'open' AND resolution IS NULL AND resolved_by IS NULL"
            " AND resolved_at IS NULL)"
            " OR (status = 'resolved' AND resolution IS NOT NULL AND resolved_by IS NOT NULL"
            " AND resolved_at IS NOT NULL)",
            name="resolution_matches_status",
        ),
        CheckConstraint(
            "pro_release_cents IS NULL OR pro_release_cents >= 0", name="pro_release_non_negative"
        ),
        CheckConstraint(
            "customer_refund_cents IS NULL OR customer_refund_cents >= 0",
            name="customer_refund_non_negative",
        ),
        Index(
            IDEMPOTENCY_KEY_INDEX,
            "opened_by",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
    )

    # One dispute per job: a second report returns this one.
    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id"), unique=True)
    opened_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    reason_code: Mapped[DisputeReason] = mapped_column(str_enum(DisputeReason, "dispute_reason"))
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[DisputeStatus] = mapped_column(
        str_enum(DisputeStatus, "dispute_status"),
        server_default=DisputeStatus.OPEN.value,
        index=True,
    )
    # The pro's one answer, for the admin who resolves it.
    pro_reply: Mapped[str | None] = mapped_column(Text)
    pro_replied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Set by the admin's resolution (#76).
    resolution: Mapped[DisputeResolution | None] = mapped_column(
        str_enum(DisputeResolution, "dispute_resolution")
    )
    resolution_note: Mapped[str | None] = mapped_column(Text)
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    pro_release_cents: Mapped[int | None]
    customer_refund_cents: Mapped[int | None]
    # The report's Idempotency-Key, NULL without one, and the SHA-256 (hex) of the body it came
    # with (app.idempotency), so a retry with another body is refused. One dispute per job, so
    # the key answers for as long as the dispute exists: no window.
    idempotency_key: Mapped[uuid.UUID | None]
    idempotency_fingerprint: Mapped[str | None] = mapped_column(String(64))


class DisputePhoto(IdTimestampsMixin, Base):
    """A photo the customer attached to their dispute (#75), with its privacy-safe copy made by
    the request media's copier (#173): metadata stripped, under an opaque key. The pro and staff
    are only ever shown the ready safe copy; the customer sees their own original until then."""

    __tablename__ = "dispute_photos"

    dispute_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("disputes.id"), index=True)
    # The customer's dispute_photo upload (u/<user_id>/dispute_photo/...); one file, one dispute.
    file_key: Mapped[str] = mapped_column(String(256), unique=True)
    uploaded_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    safe_key: Mapped[str | None] = mapped_column(String(256), unique=True)
    safe_status: Mapped[MediaSafeStatus] = mapped_column(
        str_enum(MediaSafeStatus, "media_safe_status"),
        server_default=MediaSafeStatus.PENDING.value,
    )
    safe_content_type: Mapped[str | None] = mapped_column(String(64))
