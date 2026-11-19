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
from app.modules.jobs.service import JobStatus
from app.modules.payments.schemas import PaymentSummaryOut, RefundOut, TransferOut

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
    refund_failed: bool = Field(
        description="Stripe failed or canceled the decision's refund: the money did not go "
        "back, the dispute stays open (or, resolved, needs a look) and any payout it decided "
        "stays held. Staff repair it."
    )
    refund_needs_reconciliation: bool = Field(
        description="Stripe shows a refund made (or still under way) for this dispute that its "
        "abandoned or failed refund records do not hold (#450 round 2): money may have gone "
        "back outside the records, so any payout of the job stays held until staff reconcile "
        "it in Stripe and clear the hold (docs/stripe-money.md). Never cleared on its own."
    )


class StaffDisputeList(_Out):
    disputes: list[StaffDisputeSummary] = Field(description="Oldest first.")


class StaffJobEventOut(_Out):
    type: str
    from_status: JobStatus | None
    to_status: JobStatus | None
    by_system: bool
    created_at: datetime


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
