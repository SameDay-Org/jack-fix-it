"""A job's cancellation as its customer sends it, previews it and reads it back, and as its
pro sends it and reads it back (#69).

Every amount is computed on the server from the job's payment, never taken from the body:
expected_fee_cents only guards against cancelling at a fee the customer was not shown. No
Stripe id, no name, no contact detail leaves here.
"""

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.modules.addresses.schemas import NO_NUL
from app.modules.cancellations.models import NOTE_MAX_LENGTH, CancelParty, CancelReason
from app.modules.cancellations.views import ProJobCancellation
from app.modules.jobs.service import JobStatus
from app.modules.payments.cancel_refunds import CancelRefundState

Note = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=NOTE_MAX_LENGTH, pattern=NO_NUL
    ),
]


class CustomerCancelReason(StrEnum):
    """Why the customer cancels: the reasons their app offers."""

    CHANGED_MY_MIND = CancelReason.CHANGED_MY_MIND.value
    FOUND_ANOTHER_PRO = CancelReason.FOUND_ANOTHER_PRO.value
    PRO_LATE = CancelReason.PRO_LATE.value
    OTHER = CancelReason.OTHER.value


class ProCancelReason(StrEnum):
    """Why the pro cancels: the reasons their app offers."""

    CANNOT_MAKE_IT = CancelReason.CANNOT_MAKE_IT.value
    CUSTOMER_UNREACHABLE = CancelReason.CUSTOMER_UNREACHABLE.value
    SCOPE_CHANGED = CancelReason.SCOPE_CHANGED.value
    OTHER = CancelReason.OTHER.value


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CustomerCancelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason_code: CustomerCancelReason
    note: Note | None = Field(
        default=None,
        description="Optional, plain text. Contact details are masked before it is stored; "
        "only the masked text is kept, for staff.",
    )
    expected_fee_cents: int | None = Field(
        default=None,
        ge=0,
        description="The fee_cents the preview showed. When given and cancelling now costs "
        "another fee (the pro set off since), nothing changes: 409 cancel_fee_changed. Never "
        "used as an amount.",
    )


class ProCancelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason_code: ProCancelReason
    note: Note | None = Field(
        default=None,
        description="Optional, plain text. Contact details are masked before it is stored; "
        "only the masked text is kept, for staff.",
    )


class ProCancellationOut(ProJobCancellation):
    """The cancel's answer to the pro: their job view's cancellation (who, why and when; never
    the money or the note) with the job. cancelled_by is customer when the customer cancelled
    first."""

    job_id: uuid.UUID
    job_status: JobStatus = Field(description="cancelled.")


class CancelPreviewOut(_Out):
    job_id: uuid.UUID
    job_status: JobStatus = Field(description="scheduled or on_the_way: still cancellable.")
    fee_applies: bool = Field(
        description="The pro tapped On my way (or arrived): cancelling now costs a fee."
    )
    fee_bps: int = Field(
        description="The fee's rate once the pro is on the way, in basis points of the job "
        "price (1500 = 15%), from the server's setting: for the rule line, whether or not it "
        "applies now (fee_applies)."
    )
    customer_total_cents: int = Field(description="What the customer paid, tax included.")
    fee_cents: int = Field(description="What cancelling now keeps: 0 before On my way.")
    refund_cents: int = Field(description="What cancelling now gives back: total minus fee.")
    currency: str = Field(examples=["usd"])


class CancellationOut(_Out):
    job_id: uuid.UUID
    job_status: JobStatus = Field(description="cancelled.")
    cancelled_by: CancelParty
    reason_code: CancelReason
    fee_cents: int = Field(description="Kept by the platform: 0 when cancelled before On my way.")
    refund_cents: int = Field(description="Given back to the original payment method.")
    currency: str = Field(examples=["usd"])
    refund_status: CancelRefundState = Field(
        description="none: nothing to give back. pending: on its way (Stripe has not said the "
        "money is back yet). succeeded: Stripe says it is back on the payment method. failed: "
        "it did not go through; our team looks into it."
    )
    cancelled_at: datetime
