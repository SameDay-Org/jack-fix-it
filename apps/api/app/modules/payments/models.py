import uuid
from enum import StrEnum
from typing import Final

from sqlalchemy import CheckConstraint, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum
from app.money import BPS_DENOMINATOR


class PaymentStatus(StrEnum):
    """Where a payment stands (internal; the customer sees the request's status). Created
    `requires_payment`; the payment webhooks (#61) move it on from the PaymentIntent's events."""

    REQUIRES_PAYMENT = "requires_payment"
    PROCESSING = "processing"
    # The job is created (#61): the payment is never reopened.
    SUCCEEDED = "succeeded"
    # The last attempt failed; the customer may try again with the same PaymentIntent.
    FAILED = "failed"
    # The PaymentIntent is closed: the reconciliation (#61) reopens the quote.
    CANCELED = "canceled"


# Statuses no new sheet may be issued for: the PaymentIntent cannot be confirmed again.
CLOSED_STATUSES: Final = frozenset({PaymentStatus.SUCCEEDED, PaymentStatus.CANCELED})
# Integer cents (USD): AGENTS.md "Money". The code is Stripe's lower-case currency code.
CURRENCY: Final = "usd"
# Not charged in the MVP (Cesar, 2026-11-06); to confirm with the accountant before launch.
TAX_CENTS: Final = 0


class Payment(IdTimestampsMixin, Base):
    """What the customer pays for the quote they accepted (D11.1, #58): one per accepted quote.

    Every amount is computed by the backend from database values when the row is created, and
    frozen: the job copies them when the payment succeeds (#61). The split comes from
    app.money.split_amount at the take rate stored here; the platform absorbs the card fee, so
    the pro's payout and the platform's fee add up to the amount, and the customer pays the
    amount plus the tax (0 in the MVP). The checks hold the database to those sums.
    """

    __tablename__ = "payments"
    __table_args__ = (
        CheckConstraint("amount_cents > 0", name="amount_cents_positive"),
        CheckConstraint("tax_cents >= 0", name="tax_cents_non_negative"),
        CheckConstraint("platform_fee_cents >= 0", name="platform_fee_cents_non_negative"),
        CheckConstraint("pro_payout_cents >= 0", name="pro_payout_cents_non_negative"),
        CheckConstraint(
            "customer_total_cents = amount_cents + tax_cents", name="customer_total_adds_up"
        ),
        CheckConstraint(
            "pro_payout_cents + platform_fee_cents = amount_cents", name="split_adds_up"
        ),
        CheckConstraint(
            f"take_rate_bps >= 0 AND take_rate_bps <= {BPS_DENOMINATOR}",
            name="take_rate_bps_range",
        ),
    )

    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("service_requests.id"), index=True)
    # One payment per quote; the unique index also serves the foreign key.
    quote_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("quotes.id"), unique=True)
    customer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    # The quote's price, what the customer pays on top of it, and their total.
    amount_cents: Mapped[int]
    tax_cents: Mapped[int]
    customer_total_cents: Mapped[int]
    # The split of the amount at take_rate_bps (basis points: 1500 = 15%).
    platform_fee_cents: Mapped[int]
    pro_payout_cents: Mapped[int]
    take_rate_bps: Mapped[int]
    currency: Mapped[str] = mapped_column(String(3))
    status: Mapped[PaymentStatus] = mapped_column(
        str_enum(PaymentStatus, "payment_status"),
        server_default=PaymentStatus.REQUIRES_PAYMENT.value,
        index=True,
    )
    # NULL until Stripe answered the create; the webhooks (#61) find the payment by it.
    stripe_payment_intent_id: Mapped[str | None] = mapped_column(String(255), unique=True)
