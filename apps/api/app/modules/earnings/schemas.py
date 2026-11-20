"""A pro's earnings as their app shows them (#70): what they receive ("you'll receive", the
payout frozen at payment) and where it stands. Never the customer's name, contacts or address,
the platform's fee, or a Stripe or transfer id."""

import uuid
from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class EarningStatus(StrEnum):
    """Where a job's money stands, in the pro's words."""

    # The pro marked the job done; the customer has not confirmed it yet (it confirms itself
    # after the confirmation window).
    AWAITING_CONFIRMATION = "awaiting_confirmation"
    # Confirmed, or a reported problem an admin decided with a release (all or part of the
    # payout): the transfer to the pro is to be made, or being retried.
    ON_THE_WAY = "on_the_way"
    # Held back: the customer reported a problem not decided yet, or the transfer is under
    # review.
    ON_HOLD = "on_hold"
    # Sent to the pro's Stripe account.
    PAID = "paid"


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EarningsSummary(_Out):
    """All the pro's jobs, not just this page."""

    awaiting_confirmation_cents: int
    pending_cents: int = Field(
        description="Confirmed, the transfer still to be made; a tip whose own transfer is."
    )
    on_hold_cents: int
    paid_cents: int
    currency: str = Field(examples=["usd"])


class EarningCategory(_Out):
    slug: str
    names: dict[str, str] = Field(description="Display name per locale, e.g. en and es.")


class EarningItem(_Out):
    job_id: uuid.UUID
    category: EarningCategory | None = Field(description="What the job was: the safe title.")
    amount_cents: int = Field(
        description="What the pro receives for the job, in integer cents (never the tip)."
    )
    tip_cents: int = Field(
        description="The customer's tip on the job, all of it the pro's, in integer cents; 0 "
        "when none. Its own transfer: the summary counts it by that transfer's state."
    )
    status: EarningStatus
    completed_at: datetime
    paid_at: datetime | None = Field(description="When it was paid; null until then.")
    expected_by: datetime | None = Field(
        description="awaiting_confirmation only: when the job confirms itself at the latest; "
        "null otherwise (the payout's own timing is Stripe's)."
    )


class EarningsPage(_Out):
    summary: EarningsSummary
    items: list[EarningItem] = Field(description="Newest completion first.")
    next_cursor: str | None = Field(description="Pass it as `cursor` for the next page.")
