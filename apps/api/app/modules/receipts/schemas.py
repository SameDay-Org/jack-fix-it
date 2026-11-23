from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from app.modules.users.schemas import deleted_party


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ReceiptStatus(StrEnum):
    """Where the receipt's money stands."""

    PAID = "paid"
    # A reported problem is open on the job (#75).
    UNDER_REVIEW = "under_review"
    # Some of it went back to the customer's payment method.
    PARTLY_RETURNED = "partly_returned"
    # All of it did: nothing is left paid.
    RETURNED = "returned"


class ReceiptLineKind(StrEnum):
    SERVICE = "service"
    TAX = "tax"
    TIP = "tip"
    RETURNED = "returned"


class ReceiptLine(_Out):
    kind: ReceiptLineKind = Field(description="The app names the line by its kind.")
    amount_cents: int = Field(description="Integer cents; negative for an amount returned.")
    at: datetime | None = Field(description="When it went back, for a returned amount; else null.")


class ReceiptCategory(_Out):
    slug: str
    names: dict[str, str]


class ReceiptAddress(_Out):
    """The customer's own address, on the in-app receipt only: line 1, city and state."""

    line1: str
    city: str
    state: str


class ReceiptPaymentMethod(_Out):
    """The card that paid, as Stripe's charge describes it: never more than this."""

    brand: str | None = Field(examples=["visa"], description="Stripe's brand code.")
    last4: str | None = Field(examples=["4242"])
    wallet: str | None = Field(examples=["apple_pay"], description="Stripe's wallet type.")


class ReceiptTip(_Out):
    can_tip: bool = Field(description="Whether a tip can still be added (the job's tip window).")
    closes_at: datetime | None


class ReceiptIssuer(_Out):
    """Who issues the receipt (Q-R1): the API's settings, never the app's."""

    legal_name: str
    support_email: str


class ReceiptOut(_Out):
    """A job's receipt, from the frozen amounts: the price and tax as charged, the tip once it
    went through and each amount that went back. Never the platform's fee or the pro's payout,
    and no Stripe id."""

    receipt_number: str = Field(
        examples=["JF-000124"], description="The request's public code: one receipt per job."
    )
    paid_at: datetime = Field(description="When the job's payment went through.")
    status: ReceiptStatus
    category: ReceiptCategory | None
    pro_name: str | None = Field(
        examples=["Dan R."], description="The pro's public name; null when none can be shown."
    )
    pro_deleted: bool = deleted_party("pro")
    scheduled_start_at: datetime
    completed_at: datetime | None = Field(description="When the pro marked the job done.")
    address: ReceiptAddress | None
    lines: list[ReceiptLine]
    total_paid_cents: int = Field(description="Service plus tax plus tip, minus what went back.")
    currency: str = Field(examples=["usd"], description="Stripe's lower-case currency code.")
    payment_method: ReceiptPaymentMethod | None = Field(
        description="null until Stripe's charge was read, and for a payment it gave no card for: "
        "the app then says Card."
    )
    tip: ReceiptTip | None = Field(
        description="Whether a tip can still be added and until when; null for a job that takes "
        "no tip."
    )
    issuer: ReceiptIssuer | None = Field(
        description="Who issues the receipt; null until both values are set on the server."
    )
