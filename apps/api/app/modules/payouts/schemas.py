from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class PayoutsStatus(StrEnum):
    NOT_STARTED = "not_started"
    INCOMPLETE = "incomplete"
    IN_REVIEW = "in_review"
    ENABLED = "enabled"


class OnboardingLinkOut(BaseModel):
    url: str = Field(description="Single-use Stripe-hosted onboarding page; open it in a browser.")
    expires_at: datetime


class PayoutsOut(BaseModel):
    status: PayoutsStatus = Field(
        description=(
            "not_started: no payout account yet; incomplete: Stripe still needs information; "
            "in_review: everything is submitted and Stripe is checking it; enabled: payouts "
            "are on."
        )
    )
    payouts_enabled: bool
