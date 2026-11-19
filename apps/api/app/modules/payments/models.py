import uuid
from datetime import datetime
from enum import StrEnum
from typing import Final

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text, false, text
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
# Statuses of a payment still waiting for the customer to pay: the unpaid sweep (#297) cancels
# them past PAYMENT_UNPAID_CANCEL_AFTER_SECONDS. Never processing: Stripe may still take the money.
UNPAID_STATUSES: Final = frozenset({PaymentStatus.REQUIRES_PAYMENT, PaymentStatus.FAILED})
# Integer cents (USD): AGENTS.md "Money". The code is Stripe's lower-case currency code.
CURRENCY: Final = "usd"
# Not charged in the MVP (Cesar, 2026-11-06); to confirm with the accountant before launch.
TAX_CENTS: Final = 0


class Payment(IdTimestampsMixin, Base):
    """What the customer pays for the quote they accepted (D11.1, #58): one per acceptance.

    A quote has at most one live payment (any status but canceled), enforced by a partial unique
    index. A canceled payment's PaymentIntent is closed and its quote reopened (#61); accepting
    the same quote again makes a new payment, with its own id, key and PaymentIntent.

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
        # One live payment per quote; canceled ones stay as history beside it.
        Index(
            "uq_payments_quote_id_live",
            "quote_id",
            unique=True,
            postgresql_where=text("status <> 'canceled'"),
        ),
    )

    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("service_requests.id"), index=True)
    quote_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("quotes.id"), index=True)
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
    # When the first PaymentIntent create was attempted, committed before the call: past
    # STRIPE_PAYMENT_INTENT_RECONCILE_AFTER_SECONDS Stripe may forget its key, so a retry
    # searches for the intent instead of creating again. NULL before any attempt, or after
    # staff allowed a new one (scripts/resolve_payment_intent.py).
    payment_intent_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TransferStatus(StrEnum):
    """Where the pro's transfer for a job stands (D13.3, #68; internal: the pro sees `pending`
    or `created`, staff see the row)."""

    # No transfer yet: never attempted (a pro who cannot be paid out yet has
    # last_error_code `payouts_not_enabled`), or an attempt is under way (requested_at set,
    # no last_error_code).
    PENDING = "pending"
    # Stripe made the transfer: stripe_transfer_id is stored and the job is paid_out.
    CREATED = "created"
    # The last attempt ended with an error (last_error_code); it is tried again.
    FAILED = "failed"
    # Stripe reversed the transfer (transfer.reversed): staff look at the job.
    REVERSED = "reversed"


# Statuses of a transfer Stripe made: the row holds its id, and nothing creates another.
MADE_STATUSES: Final = frozenset({TransferStatus.CREATED, TransferStatus.REVERSED})
# last_error_code holds a Stripe error code, an exception's class name or one of ours: never
# a message. Stripe's codes are short identifiers; anything longer is cut.
TRANSFER_ERROR_CODE_LENGTH: Final = 64


class Transfer(IdTimestampsMixin, Base):
    """The transfer to the pro once their job is confirmed (D13.3, #68; ADR 0005): at most one
    per job, which the unique job_id enforces. It is the guard against paying a job twice,
    with the Stripe idempotency key derived from the job id.

    The amount is the job's frozen pro_payout_cents, copied when the row is created: never
    computed again from a rate. The row is committed before any Stripe call, and each attempt
    (attempts, requested_at) is committed before its call too, so a lost answer leaves a row
    that says a create may have landed: the next attempt looks the transfer up in Stripe before
    it creates anything (transfers.py).
    """

    __tablename__ = "transfers"
    __table_args__ = (
        CheckConstraint("amount_cents > 0", name="amount_cents_positive"),
        CheckConstraint("attempts >= 0", name="attempts_non_negative"),
        # A transfer Stripe made holds its id.
        CheckConstraint(
            "status NOT IN ('created', 'reversed') OR stripe_transfer_id IS NOT NULL",
            name="made_has_stripe_transfer_id",
        ),
    )

    # One transfer per job: the double-pay guard.
    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id"), unique=True)
    payment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("payments.id"), index=True)
    pro_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pro_profiles.id"), index=True)
    amount_cents: Mapped[int]
    currency: Mapped[str] = mapped_column(String(3))
    status: Mapped[TransferStatus] = mapped_column(
        str_enum(TransferStatus, "transfer_status"),
        server_default=TransferStatus.PENDING.value,
        index=True,
    )
    # NULL until Stripe answered the create (or the lookup found it).
    stripe_transfer_id: Mapped[str | None] = mapped_column(String(255), unique=True)
    # `transfer:<job id>`: the same for every attempt of this job's transfer.
    idempotency_key: Mapped[str] = mapped_column(String(255), unique=True)
    # Stripe attempts started (each committed before its call).
    attempts: Mapped[int] = mapped_column(server_default="0")
    last_error_code: Mapped[str | None] = mapped_column(String(TRANSFER_ERROR_CODE_LENGTH))
    # When the latest attempt started; NULL before the first.
    requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Once Stripe made the transfer, it is read again by its stored id, for a reversal whose
    # event came before the id was stored (transfers.py, step 4). When the latest such read
    # started (the release's own, or the recovery cron's), and when one last succeeded: NULL
    # until then, so the need for it outlives a failed or cancelled read (#416 r2).
    reversal_check_tried_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reversal_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The initiation boundary (#450 round 4): when the current attempt passed its last hold
    # check, under the job's lock, right before the create. NULL until then; cleared when a new
    # attempt starts. A late refund that finds it set (or the transfer made) cannot stop the
    # create any more: it flags the transfer instead.
    create_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # When a late refund found this transfer issued, or possibly issued: staff reverse it by
    # hand (docs/stripe-money.md). Never cleared by the code.
    needs_reversal_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RefundStatus(StrEnum):
    """Where a refund to the customer stands (#76; internal: staff read the row)."""

    # Stripe holds no refund of ours yet: an attempt is under way (requested_at set, no
    # last_error_code), or the row was just written and its first attempt is about to start.
    PENDING = "pending"
    # Stripe created the refund: stripe_refund_id and stripe_status are stored. Created is not
    # done: the money is back only once stripe_status is `succeeded` (STRIPE_REFUND_SUCCEEDED),
    # and Stripe can still fail or cancel it (STRIPE_REFUND_DEAD).
    CREATED = "created"
    # The last attempt's call ended with an error (last_error_code) and Stripe holds no refund
    # of ours that we know of; the same decision tries again.
    FAILED = "failed"
    # Staff gave it up (#434, scripts/resolve_dispute_refund.py, audited) once Stripe showed no
    # refund of the dispute that could still move money: it no longer fixes the dispute's
    # decision, and an admin may decide again, a refund then taking a new row and key. Final.
    ABANDONED = "abandoned"


# Statuses of a refund not made yet: an attempt may still be started for it.
REFUND_NOT_MADE: Final = frozenset({RefundStatus.PENDING, RefundStatus.FAILED})
# Stripe's own status of a refund (stripe_status, stored as Stripe says it): the money is back
# only at `succeeded`; `failed` and `canceled` will never give it back; anything else (pending,
# requires_action, or a status a later API version adds) is not finished.
STRIPE_REFUND_SUCCEEDED: Final = "succeeded"
STRIPE_REFUND_DEAD: Final = frozenset({"failed", "canceled"})
STRIPE_STATUS_LENGTH: Final = 32
# How final each of Stripe's statuses of a refund is. Stripe moves a refund forward only: not
# finished, then succeeded, failed or canceled (a succeeded one can still fail, never the other
# way). A read less final than the row's is older than it (two readers raced): never stored.
STRIPE_RANK_NONE: Final = 0
STRIPE_RANK_UNFINISHED: Final = 1
STRIPE_RANK_SUCCEEDED: Final = 2
STRIPE_RANK_DEAD: Final = 3


def stripe_status_rank(status: str | None) -> int:
    """How final Stripe's status of a refund is (see STRIPE_RANK_*); unknown is unfinished."""
    if status is None:
        return STRIPE_RANK_NONE
    if status == STRIPE_REFUND_SUCCEEDED:
        return STRIPE_RANK_SUCCEEDED
    if status in STRIPE_REFUND_DEAD:
        return STRIPE_RANK_DEAD
    return STRIPE_RANK_UNFINISHED


# As for transfers: a Stripe error code, an exception's class name or one of ours, cut.
REFUND_ERROR_CODE_LENGTH: Final = 64


class Refund(IdTimestampsMixin, Base):
    """Money given back to the customer from their job's payment (#76: an admin's dispute
    resolution, in full or in part): to the original payment method, through Stripe's Refund
    API. The idempotency key names what the refund is for (`dispute:<id>:refund`), and is
    unique: one refund per dispute, the guard against refunding it twice.

    The amount is computed by the backend from the frozen payment amounts (disputes.resolution)
    and copied when the row is created. As for transfers, the row and each attempt (attempts,
    requested_at) are committed before the Stripe call, so a lost answer leaves a row that says
    a refund may have been made: the next attempt looks it up in Stripe before creating one.

    A dispute holds one refund that is not abandoned. Its key is `dispute:<id>:refund` for the
    first, `dispute:<id>:refund:<n>` for the n-th after staff abandoned the earlier ones (#434),
    so Stripe never answers a new decision with an abandoned refund's stored answer.

    Stripe's status of the refund is kept as Stripe says it (stripe_status) and read again
    (an admin's retry, or Stripe's refund events): what the refund settles waits for
    `succeeded` (#433 round 1). A dispute's refund also carries the decision it pays for,
    written once with the row: the admin who took it (initiated_by), the part of the pro's
    payout released with it, and the admin's note (the dispute's once it settles).
    """

    __tablename__ = "refunds"
    __table_args__ = (
        CheckConstraint("amount_cents > 0", name="amount_cents_positive"),
        CheckConstraint("attempts >= 0", name="attempts_non_negative"),
        # A refund Stripe made holds its id.
        CheckConstraint(
            "status <> 'created' OR stripe_refund_id IS NOT NULL",
            name="created_has_stripe_refund_id",
        ),
        # Stripe's status is stored with its refund, and only then; an abandoned row keeps
        # whatever it had (#434).
        CheckConstraint(
            "status = 'abandoned' OR (status = 'created') = (stripe_status IS NOT NULL)",
            name="created_has_stripe_status",
        ),
        # One refund per dispute that is not abandoned: the one its decision carries out.
        Index(
            "uq_refunds_current_dispute_refund",
            "dispute_id",
            unique=True,
            postgresql_where=text("dispute_id IS NOT NULL AND status <> 'abandoned'"),
        ),
        CheckConstraint(
            "dispute_id IS NULL OR (initiated_by IS NOT NULL AND pro_release_cents IS NOT NULL"
            " AND resolution_note IS NOT NULL)",
            name="dispute_refund_has_decision",
        ),
        CheckConstraint(
            "pro_release_cents IS NULL OR pro_release_cents >= 0",
            name="pro_release_non_negative",
        ),
    )

    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id"), index=True)
    payment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("payments.id"), index=True)
    # The dispute it settles; NULL for a refund of another kind (cancellations, #69).
    dispute_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("disputes.id"), index=True)
    amount_cents: Mapped[int]
    currency: Mapped[str] = mapped_column(String(3))
    status: Mapped[RefundStatus] = mapped_column(
        str_enum(RefundStatus, "refund_status"),
        server_default=RefundStatus.PENDING.value,
        index=True,
    )
    # NULL until Stripe answered the create (or the lookup found the refund).
    stripe_refund_id: Mapped[str | None] = mapped_column(String(255), unique=True)
    # The same for every attempt of this refund.
    idempotency_key: Mapped[str] = mapped_column(String(255), unique=True)
    # Stripe attempts started (each committed before its call).
    attempts: Mapped[int] = mapped_column(server_default="0")
    last_error_code: Mapped[str | None] = mapped_column(String(REFUND_ERROR_CODE_LENGTH))
    # The last attempt's failure was Stripe's definitive answer to the create (a 4xx error with
    # a Stripe code, not a timeout, a 409, a 429 or a 5xx): the same key gets the same refusal,
    # so that create can never make a refund. Only such a refund may be abandoned (#434).
    last_error_definitive: Mapped[bool] = mapped_column(server_default=false())
    # When the latest attempt started; NULL before the first.
    requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Stripe's status of the refund as last read (pending, requires_action, succeeded, failed,
    # canceled); NULL until Stripe answered with the refund.
    stripe_status: Mapped[str | None] = mapped_column(String(STRIPE_STATUS_LENGTH))
    # The admin whose decision this refund carries out; NULL only for a refund of another kind.
    initiated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    # The part of the pro's payout the decision releases with this refund: 0 for a full refund.
    pro_release_cents: Mapped[int | None]
    # The deciding admin's note (staff only, never logged): the dispute's resolution_note once
    # the refund settles it.
    resolution_note: Mapped[str | None] = mapped_column(Text)
    # When a signed refund event, read again from Stripe, showed a refund Stripe made or still
    # holds for the dispute while this row was abandoned or failed (#450 round 2): money our
    # rows do not show may have moved. The job's payout stays held (payments.transfers) until
    # staff reconcile it in Stripe and clear this by hand (docs/stripe-money.md); no code ever
    # clears it.
    late_refund_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
