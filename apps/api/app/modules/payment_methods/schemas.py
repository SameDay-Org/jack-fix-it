from typing import Final

from pydantic import BaseModel, ConfigDict, Field

# A Stripe PaymentMethod id as a path parameter: the prefix, then ASCII letters, digits and
# underscores only (nothing that could change the path of the call to Stripe), within the 255
# characters Stripe allows an id.
PAYMENT_METHOD_ID_PATTERN: Final = r"^pm_[A-Za-z0-9_]{1,252}$"


class SetupIntentOut(BaseModel):
    """What the app's Payment Sheet needs, in setup mode, to save a card on the customer."""

    model_config = ConfigDict(extra="forbid")

    client_secret: str = Field(
        description="The SetupIntent's client secret: the sheet confirms the card with it. "
        "Shown once per call, never logged; a new SetupIntent on every call."
    )
    ephemeral_key_secret: str = Field(
        description="A short-lived key that lets the sheet act for the customer; new on each call."
    )
    customer_id: str = Field(description="The customer's Stripe Customer id, for the sheet.")
    publishable_key: str = Field(
        description="The Stripe publishable key the sheet initializes with (pk_test_ until launch)."
    )


class PaymentMethodOut(BaseModel):
    """A saved card as the wallet shows it: never the full number, the CVC, the fingerprint or
    the billing details (the API never holds them)."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="The Stripe PaymentMethod id: the path id of the other routes.")
    brand: str = Field(
        examples=["visa"],
        description="Stripe's card brand: amex, diners, discover, eftpos_au, jcb, link, "
        "mastercard, unionpay, visa or unknown.",
    )
    last4: str = Field(examples=["4242"], description="The card number's last four digits.")
    exp_month: int = Field(examples=[12], description="The expiry month, 1 to 12.")
    exp_year: int = Field(examples=[2028], description="The expiry year, four digits.")
    is_default: bool = Field(description="Whether this is the customer's default payment method.")
