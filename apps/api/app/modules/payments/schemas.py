from pydantic import BaseModel, ConfigDict, Field


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
