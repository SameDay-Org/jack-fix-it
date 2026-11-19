import uuid
from datetime import datetime
from enum import StrEnum
from typing import Final

from sqlalchemy import (
    CHAR,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    SmallInteger,
    String,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum


class TipChoice(StrEnum):
    """What the customer chose (#273): no tip, one of the offered percents, or an amount."""

    NONE = "none"
    PERCENT = "percent"
    CUSTOM = "custom"


class TipStatus(StrEnum):
    """Where a tip stands. `declined` is the choice "No tip" (no PaymentIntent); the others
    follow the current attempt's PaymentIntent, moved by its payment_intent.* events."""

    DECLINED = "declined"
    REQUIRES_PAYMENT = "requires_payment"
    PROCESSING = "processing"
    # The money was taken: nothing changes the tip again.
    SUCCEEDED = "succeeded"
    # The last charge failed; the same PaymentIntent can be confirmed again.
    FAILED = "failed"
    # The PaymentIntent is closed (the customer changed the amount, or the unpaid sweep).
    CANCELED = "canceled"


class TipTransferStatus(StrEnum):
    """The tip's transfer to the pro (#273 PR A2): `none` until a tip succeeds."""

    NONE = "none"
    PENDING = "pending"
    CREATED = "created"
    PAID = "paid"
    FAILED = "failed"
    HELD = "held"


# A tip still waiting for the customer to pay: the unpaid sweep cancels its PaymentIntent past
# PAYMENT_UNPAID_CANCEL_AFTER_SECONDS. Never processing: Stripe may still take the money.
UNPAID_STATUSES: Final = frozenset({TipStatus.REQUIRES_PAYMENT, TipStatus.FAILED})


class Tip(IdTimestampsMixin, Base):
    """The customer's tip for the pro on a confirmed job (#273): at most one per job, which the
    unique job_id enforces.

    The amount is computed by the backend from the job's frozen price before tax (a percent,
    app.money.tip_amount) or checked against the bounds in settings (a custom amount): never
    taken from the client as is. Each PaymentIntent the tip has is an attempt: `attempt` counts
    them, and the idempotency key `tip:<id>:<attempt>` is the current one's. Its create time is
    committed before the call, as for a payment, so a lost answer leaves a row that says a
    create may have landed. The card, the transfer and the receipt columns are filled by the
    receipt (#62) and the tip transfer (#273 PR A2).
    """

    __tablename__ = "tips"
    __table_args__ = (
        CheckConstraint("amount_cents >= 0", name="amount_cents_non_negative"),
        # "No tip" is 0 and declined; any other choice is an amount above 0 to pay.
        CheckConstraint("(choice = 'none') = (amount_cents = 0)", name="amount_matches_choice"),
        CheckConstraint("(choice = 'none') = (status = 'declined')", name="status_matches_choice"),
        CheckConstraint(
            "(choice = 'percent') = (percent IS NOT NULL)", name="percent_matches_choice"
        ),
        CheckConstraint("percent IS NULL OR percent > 0", name="percent_positive"),
        CheckConstraint("attempt >= 0", name="attempt_non_negative"),
        CheckConstraint(
            "(status = 'succeeded') = (succeeded_at IS NOT NULL)", name="succeeded_has_time"
        ),
        CheckConstraint("card_last4 ~ '^[0-9]{4}$'", name="card_last4_four_digits"),
        CheckConstraint("transfer_attempts >= 0", name="transfer_attempts_non_negative"),
        # The unpaid sweep's read: the tips still unpaid, by their current attempt's age.
        Index(
            "ix_tips_unpaid_requested_at",
            "payment_intent_requested_at",
            postgresql_where=text(
                "status IN ('requires_payment', 'failed') AND stripe_payment_intent_id IS NOT NULL"
            ),
        ),
    )

    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id"), unique=True)
    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("service_requests.id"), index=True)
    customer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    pro_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pro_profiles.id"), index=True)
    choice: Mapped[TipChoice] = mapped_column(str_enum(TipChoice, "tip_choice"))
    # The offered percent the amount was computed from; NULL for any other choice.
    percent: Mapped[int | None] = mapped_column(SmallInteger)
    amount_cents: Mapped[int]
    currency: Mapped[str] = mapped_column(String(3))
    status: Mapped[TipStatus] = mapped_column(str_enum(TipStatus, "tip_status"))
    # The current attempt's PaymentIntent: NULL until Stripe answered its create, and once the
    # customer chose "No tip".
    stripe_payment_intent_id: Mapped[str | None] = mapped_column(String(255), unique=True)
    # How many PaymentIntents the tip asked for: the current one's key is tip:<id>:<attempt>.
    attempt: Mapped[int] = mapped_column(server_default="0")
    # When the current attempt's create was first sent, committed before the call.
    payment_intent_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # For the receipt (#62): the card that paid, never more than its brand and last 4 digits.
    card_brand: Mapped[str | None] = mapped_column(String(32))
    card_last4: Mapped[str | None] = mapped_column(CHAR(4))
    wallet: Mapped[str | None] = mapped_column(String(32))
    succeeded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The transfer of the whole tip to the pro (#273 PR A2).
    transfer_status: Mapped[TipTransferStatus] = mapped_column(
        str_enum(TipTransferStatus, "tip_transfer_status"),
        server_default=TipTransferStatus.NONE.value,
    )
    stripe_transfer_id: Mapped[str | None] = mapped_column(String(255), unique=True)
    transfer_idempotency_key: Mapped[str | None] = mapped_column(String(255), unique=True)
    transfer_attempts: Mapped[int] = mapped_column(server_default="0")
    transfer_last_error_code: Mapped[str | None] = mapped_column(String(64))
    transfer_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # When the tip's receipt email was sent (#62).
    receipt_emailed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
