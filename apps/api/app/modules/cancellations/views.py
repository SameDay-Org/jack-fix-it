"""A job's cancellation as each side's job view shows it (#69). A leaf: it never imports the
jobs module, whose job views (jobs.schemas) embed these."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.modules.cancellations.models import CancelParty, CancelReason
from app.modules.payments.cancel_refunds import CancelRefundState


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CustomerJobCancellation(_Out):
    """The cancellation of the customer's job, as their job view shows it."""

    cancelled_by: CancelParty
    reason_code: CancelReason
    cancelled_at: datetime
    fee_cents: int = Field(description="Kept by the platform: 0 when cancelled before On my way.")
    refund_cents: int = Field(description="Given back to the original payment method.")
    refund_status: CancelRefundState = Field(
        description="none, pending, succeeded or failed, as on the cancel's answer."
    )


class ProJobCancellation(_Out):
    """The cancellation of the pro's job, as their job view shows it: who, why and when; never
    the money or the note."""

    cancelled_by: CancelParty
    reason_code: CancelReason
    cancelled_at: datetime
