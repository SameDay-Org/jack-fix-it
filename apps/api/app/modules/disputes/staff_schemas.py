"""Disputes as staff see them, and an admin's resolution (#76).

Staff (agents and admins) read the list and a dispute in full: both sides' text as stored
(masked), the photos' safe copies, the job's history and the money. Only admins resolve. A
resolution names its decision and, for a partial one, the part of the pro's payout to release:
every other amount is computed on the server from the frozen job and payment amounts.
"""

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.modules.addresses.schemas import NO_NUL
from app.modules.disputes.models import (
    NOTE_MAX_LENGTH,
    DisputeReason,
    DisputeResolution,
    DisputeStatus,
)
from app.modules.disputes.schemas import DisputePhotoOut
from app.modules.jobs.models import JobStatus
from app.modules.payments.models import PaymentStatus, RefundStatus
from app.modules.payments.schemas import TransferOut

Note = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=NOTE_MAX_LENGTH, pattern=NO_NUL
    ),
]


class ResolutionDecision(StrEnum):
    """What the admin decides (#76): the pro paid in full, the customer refunded in full, or a
    split of the two."""

    RELEASE = "release"
    PARTIAL = "partial"
    REFUND = "refund"


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DisputeResolveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: ResolutionDecision
    pro_release_cents: int | None = Field(
        default=None,
        gt=0,
        description="partial only (required there, refused otherwise): the part of the pro's "
        "payout to release, in integer cents, more than 0 and less than the payout. The "
        "customer's refund is computed from it on the server.",
    )
    note: Note = Field(
        description="Why, for the record (staff only: never shown to the customer or the pro, "
        "never logged). Kept with the dispute and in the audit log."
    )

    @model_validator(mode="after")
    def _amount_only_for_partial(self) -> Self:
        if (self.decision is ResolutionDecision.PARTIAL) != (self.pro_release_cents is not None):
            raise ValueError("pro_release_cents is required for partial and refused otherwise")
        return self


class RefundOut(_Out):
    """A dispute's refund to the customer (#76): the row, without the idempotency key."""

    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    amount_cents: int = Field(description="What is refunded, in integer cents.")
    currency: str = Field(examples=["usd"])
    status: RefundStatus = Field(
        description="pending: not made yet, an attempt may be under way. created: Stripe made "
        "the refund. failed: the last attempt failed; the same decision tries again."
    )
    stripe_refund_id: str | None = Field(description="Stripe's id of the refund, once made.")
    attempts: int
    last_error_code: str | None = Field(
        description="Why the last attempt did not make the refund: a Stripe error code, an "
        "error class or `refund_needs_review`. Never a message."
    )
    requested_at: datetime | None = Field(description="When the latest attempt started.")


class DisputeResolutionOut(_Out):
    """Where the dispute stands after a resolve (#76)."""

    id: uuid.UUID
    job_id: uuid.UUID
    status: DisputeStatus
    resolution: DisputeResolution | None
    pro_release_cents: int | None = Field(description="What the pro is paid; null while open.")
    customer_refund_cents: int | None = Field(
        description="What the customer gets back; null while open."
    )
    resolved_at: datetime | None
    job_status: JobStatus = Field(
        description="disputed until the money moved: paid_out once the transfer to the pro is "
        "made (a release, full or partial), refunded at once for a full refund."
    )
    refund: RefundOut | None = Field(description="The refund, when the decision has one.")


class StaffDisputeSummary(_Out):
    """One line of the staff list."""

    id: uuid.UUID
    job_id: uuid.UUID
    public_code: str = Field(examples=["JFX-7Q2K"], description="The request's public code.")
    status: DisputeStatus
    reason_code: DisputeReason
    resolution: DisputeResolution | None
    job_status: JobStatus
    customer_first_name: str | None
    pro_first_name: str | None
    customer_total_cents: int | None = Field(
        description="What the customer paid, tax included; null when the job's payment is "
        "missing (a dispute that needs review)."
    )
    pro_payout_cents: int = Field(description="The pro's payout frozen at payment.")
    pro_release_cents: int | None
    customer_refund_cents: int | None
    currency: str | None
    opened_at: datetime = Field(description="When the customer reported it: its age.")
    resolved_at: datetime | None


class StaffDisputeList(_Out):
    disputes: list[StaffDisputeSummary] = Field(description="Oldest first.")


class StaffJobEventOut(_Out):
    type: str
    from_status: JobStatus | None
    to_status: JobStatus | None
    by_system: bool
    created_at: datetime


class PaymentSummaryOut(_Out):
    """The job's payment, frozen when it was made."""

    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    amount_cents: int
    tax_cents: int
    customer_total_cents: int
    platform_fee_cents: int
    pro_payout_cents: int
    currency: str
    status: PaymentStatus


class StaffDisputeOut(StaffDisputeSummary):
    """A dispute in full for staff (#76). Reading it is recorded in the audit log."""

    description: str = Field(description="The customer's text, as stored (masked).")
    pro_reply: str | None = Field(description="The pro's one answer, as stored (masked).")
    pro_replied_at: datetime | None
    resolution_note: str | None = Field(description="The resolving admin's note (staff only).")
    resolved_by: uuid.UUID | None
    photos: list[DisputePhotoOut] = Field(description="The safe copies, once ready.")
    photos_pending: int
    events: list[StaffJobEventOut] = Field(description="The job's history, oldest first.")
    payment: PaymentSummaryOut | None
    refund: RefundOut | None
    transfer: TransferOut | None
