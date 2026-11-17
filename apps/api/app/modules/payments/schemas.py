import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.modules.payments.models import TransferStatus


class PaymentCreate(BaseModel):
    """No input: every amount comes from the accepted quote and the platform's take rate, read
    from the database (AGENTS.md "Money"). A client sending any field, an amount above all,
    gets a 422; an empty body or none at all is fine."""

    model_config = ConfigDict(extra="forbid")


class PaymentSheetOut(BaseModel):
    """What the app's Payment Sheet (#59) needs, plus what the customer sees before paying.
    Never the pro's payout or the platform's fee."""

    model_config = ConfigDict(extra="forbid")

    payment_intent_client_secret: str = Field(
        description="The PaymentIntent's client secret: the sheet confirms the payment with it. "
        "Shown once per call, never logged; the same PaymentIntent on every call for the quote."
    )
    customer_id: str = Field(description="The customer's Stripe Customer id, for the sheet.")
    ephemeral_key_secret: str = Field(
        description="A short-lived key that lets the sheet act for the customer; new on each call."
    )
    publishable_key: str = Field(
        description="The Stripe publishable key the sheet initializes with (pk_test_ until launch)."
    )
    amount_cents: int = Field(description="The accepted quote's price, in integer cents.")
    tax_cents: int = Field(description="Tax on top of the price: 0, not charged in the MVP.")
    customer_total_cents: int = Field(description="What the sheet charges: the price plus the tax.")
    currency: str = Field(examples=["usd"], description="Stripe's lower-case currency code.")


class TransferOut(BaseModel):
    """A job's transfer to its pro as staff see it (#68): the row, without the idempotency
    key."""

    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    job_id: uuid.UUID
    payment_id: uuid.UUID
    pro_id: uuid.UUID = Field(description="The pro's profile id.")
    amount_cents: int = Field(
        description="The job's pro payout as frozen at payment, in integer cents."
    )
    currency: str = Field(examples=["usd"], description="Stripe's lower-case currency code.")
    status: TransferStatus = Field(
        description="pending: not made yet (last_error_code `payouts_not_enabled` when the pro "
        "cannot be paid out yet). created: Stripe made the transfer. failed: the last attempt "
        "failed and is tried again. reversed: Stripe reversed the transfer."
    )
    stripe_transfer_id: str | None = Field(
        description="Stripe's id of the transfer, once it is made."
    )
    attempts: int = Field(description="Attempts made with Stripe so far.")
    last_error_code: str | None = Field(
        description="Why the last attempt did not make the transfer: a Stripe error code, an "
        "error class, `payouts_not_enabled` or `transfer_needs_review`. Never a message."
    )
    requested_at: datetime | None = Field(description="When the latest attempt started.")
    created_at: datetime
    updated_at: datetime


class JobTransferOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    transfer: TransferOut | None = Field(
        description="The job's transfer; null before the first attempt to release it."
    )
