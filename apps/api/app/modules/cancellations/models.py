import uuid
from enum import StrEnum
from typing import Final

from sqlalchemy import CheckConstraint, ForeignKey, Index, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum

# The longest note the cancelling side writes, in characters, as stored (redacted, trimmed).
NOTE_MAX_LENGTH: Final = 500
# One cancellation per job. The name is the naming convention's (its first column).
ONE_PER_JOB: Final = "uq_job_cancellations_job_id"
# One cancellation per user and Idempotency-Key: a key never cancels a second job.
IDEMPOTENCY_KEY_INDEX: Final = "uq_job_cancellations_cancelled_by_idempotency_key"


class CancelParty(StrEnum):
    """Who cancelled the job: its customer or its pro."""

    CUSTOMER = "customer"
    PRO = "pro"


class CancelReason(StrEnum):
    """Why, as the cancelling side picks it (#69): the customer's first four, the pro's last
    three, and `other` for both."""

    CHANGED_MY_MIND = "changed_my_mind"
    FOUND_ANOTHER_PRO = "found_another_pro"
    PRO_LATE = "pro_late"
    OTHER = "other"
    CANNOT_MAKE_IT = "cannot_make_it"
    CUSTOMER_UNREACHABLE = "customer_unreachable"
    SCOPE_CHANGED = "scope_changed"


CUSTOMER_REASONS: Final = frozenset(
    {
        CancelReason.CHANGED_MY_MIND,
        CancelReason.FOUND_ANOTHER_PRO,
        CancelReason.PRO_LATE,
        CancelReason.OTHER,
    }
)
PRO_REASONS: Final = frozenset(
    {
        CancelReason.CANNOT_MAKE_IT,
        CancelReason.CUSTOMER_UNREACHABLE,
        CancelReason.SCOPE_CHANGED,
        CancelReason.OTHER,
    }
)


class CancelledFrom(StrEnum):
    """The job's status when it was cancelled: before the pro's "On my way", or after it (on
    the way, arrived included), which is what the fee depends on."""

    SCHEDULED = "scheduled"
    ON_THE_WAY = "on_the_way"


def _quoted(reasons: frozenset[CancelReason]) -> str:
    return ", ".join(f"'{reason.value}'" for reason in sorted(reasons))


class JobCancellation(IdTimestampsMixin, Base):
    """A job cancelled by its customer or its pro before the work started (#69): at most one
    per job. The job's own status moves to cancelled through its state machine in the same
    transaction; this row keeps who, why, from which status and the money split, computed on
    the server and frozen here: the fee rate used (fee_bps), the fee the platform keeps and the
    refund to the customer (their sum is the customer's total). The refund itself is a refunds
    row (payments.cancel_refunds), made by the worker.

    `note` is the cancelling side's text after the contact redaction (app.redaction), the only
    form ever stored, and never logged.
    """

    __tablename__ = "job_cancellations"
    __table_args__ = (
        CheckConstraint(
            f"note IS NULL OR char_length(note) BETWEEN 1 AND {NOTE_MAX_LENGTH}",
            name="note_length",
        ),
        CheckConstraint(
            f"(party = 'customer' AND reason_code IN ({_quoted(CUSTOMER_REASONS)}))"
            f" OR (party = 'pro' AND reason_code IN ({_quoted(PRO_REASONS)}))",
            name="reason_of_party",
        ),
        CheckConstraint("fee_bps BETWEEN 0 AND 10000", name="fee_bps_range"),
        CheckConstraint("fee_cents >= 0", name="fee_cents_non_negative"),
        CheckConstraint("refund_cents >= 0", name="refund_cents_non_negative"),
        Index(
            IDEMPOTENCY_KEY_INDEX,
            "cancelled_by",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
    )

    # One cancellation per job: a second cancel returns this one.
    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id"), unique=True)
    cancelled_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    party: Mapped[CancelParty] = mapped_column(str_enum(CancelParty, "cancel_party"))
    reason_code: Mapped[CancelReason] = mapped_column(str_enum(CancelReason, "cancel_reason"))
    note: Mapped[str | None] = mapped_column(Text)
    from_status: Mapped[CancelledFrom] = mapped_column(str_enum(CancelledFrom, "cancelled_from"))
    fee_bps: Mapped[int]
    fee_cents: Mapped[int]
    refund_cents: Mapped[int]
    # The cancel's Idempotency-Key, NULL without one, and the SHA-256 (hex) of the body it came
    # with (app.idempotency). One cancellation per job: the key answers for as long as it exists.
    idempotency_key: Mapped[uuid.UUID | None]
    idempotency_fingerprint: Mapped[str | None] = mapped_column(String(64))
