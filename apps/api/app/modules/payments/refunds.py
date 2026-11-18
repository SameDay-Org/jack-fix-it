"""The Stripe step of a refund to the customer (#76): found again or created, never twice.

The caller (disputes.resolution) commits the refund row and the attempt before calling
`make_refund`, with no transaction open, and stores what it returns. An attempt after the first
may follow a lost answer: it first lists the PaymentIntent's refunds and adopts the one whose
metadata names the dispute, if exactly one that still stands fits the row (amount, currency).
More than one, one that does not fit, a failed or canceled one, or a listing with further pages
creates nothing (RefundNeedsReviewError: staff look in Stripe). Otherwise the refund is created
for the row's amount with the idempotency key `dispute:<id>:refund`, the same for every attempt,
so Stripe itself answers a repeated create with the first one's refund while it keeps the key.
"""

import uuid
from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.stripe_refunds import RefundFacts, StripeRefunds
from app.modules.payments.models import (
    REFUND_ERROR_CODE_LENGTH,
    Payment,
    Refund,
    RefundStatus,
)
from app.modules.payments.repository import PaymentRepository, RefundRepository, TransferRepository
from app.modules.payments.schemas import PaymentSummaryOut, RefundOut

# last_error_code of a refund whose Stripe records cannot be matched with its row.
REFUND_NEEDS_REVIEW: Final = "refund_needs_review"


def dispute_refund_key(dispute_id: uuid.UUID) -> str:
    """The same key for every attempt to refund this dispute (AGENTS.md "Money": every refund
    carries a deterministic idempotency key). Unique on the row: one refund per dispute."""
    return f"dispute:{dispute_id}:refund"


@dataclass(frozen=True)
class RefundAttempt:
    """One Stripe attempt as its steps need it, copied before the transaction that stamped it
    ends."""

    refund_id: uuid.UUID
    dispute_id: uuid.UUID
    job_id: uuid.UUID
    payment_id: uuid.UUID
    payment_intent_id: str
    amount_cents: int
    currency: str
    idempotency_key: str
    number: int

    @property
    def ids(self) -> dict[str, str | int]:
        """For logs: ids and the attempt's number only."""
        return {
            "refund_id": str(self.refund_id),
            "dispute_id": str(self.dispute_id),
            "job_id": str(self.job_id),
            "payment_id": str(self.payment_id),
            "attempt": self.number,
        }


@dataclass(frozen=True)
class PaymentFacts:
    """A job's succeeded payment as a refund reads it (#76): its ids and frozen amounts."""

    payment_id: uuid.UUID
    payment_intent_id: str | None
    currency: str
    customer_total_cents: int
    pro_payout_cents: int


class RefundBlocked(StrEnum):
    """Why no attempt was started for a dispute's refund."""

    # A refund of another amount was attempted: Stripe may hold it.
    ANOTHER_AMOUNT = "another_amount"
    # An attempt with no outcome yet is under way (or too recent to be taken for lost).
    IN_FLIGHT = "in_flight"
    # The row holds a refund Stripe made: nothing to attempt.
    MADE = "made"


class RefundLedger:
    """The refund rows of disputes and the job's payment, for the disputes module (ADR 0003:
    no other module reads these tables). Everything runs in the caller's session and
    transaction; nothing here commits."""

    def __init__(self, session: AsyncSession) -> None:
        self._refunds = RefundRepository(session)
        self._payments = PaymentRepository(session)
        self._transfers = TransferRepository(session)

    async def payment_of_quote(self, quote_id: uuid.UUID) -> PaymentFacts | None:
        """The quote's succeeded payment (the job's), or None."""
        payment = await self._payments.succeeded_of_quote(quote_id)
        return None if payment is None else _payment_facts(payment)

    async def payments_of_quotes(
        self, quote_ids: Collection[uuid.UUID]
    ) -> dict[uuid.UUID, PaymentFacts]:
        """payment_of_quote for each quote that has one, by quote, in one statement."""
        found = await self._payments.succeeded_of_quotes(quote_ids)
        return {quote_id: _payment_facts(payment) for quote_id, payment in found.items()}

    async def payment_summary(self, quote_id: uuid.UUID) -> PaymentSummaryOut | None:
        payment = await self._payments.succeeded_of_quote(quote_id)
        return None if payment is None else PaymentSummaryOut.model_validate(payment)

    async def job_has_transfer(self, job_id: uuid.UUID) -> bool:
        return await self._transfers.get_of_job(job_id) is not None

    async def attempted(self, dispute_id: uuid.UUID) -> bool:
        """Whether a refund was ever attempted for the dispute; its row, if any, stays locked
        until the transaction ends."""
        return await self._refunds.by_key_for_update(dispute_refund_key(dispute_id)) is not None

    async def start_attempt(
        self,
        *,
        dispute_id: uuid.UUID,
        job_id: uuid.UUID,
        payment: PaymentFacts,
        amount_cents: int,
        now: datetime,
        stuck_after: timedelta,
    ) -> RefundAttempt | RefundBlocked:
        """The dispute's refund row (created now for `amount_cents`, or the one an earlier
        attempt left) locked, and a new attempt stamped on it. The caller holds the job's lock
        and commits before calling Stripe."""
        key = dispute_refund_key(dispute_id)
        refund = await self._refunds.by_key_for_update(key)
        if refund is not None and refund.amount_cents != amount_cents:
            return RefundBlocked.ANOTHER_AMOUNT
        if refund is not None and _in_flight(refund, now, stuck_after):
            return RefundBlocked.IN_FLIGHT
        if payment.payment_intent_id is None:  # pragma: no cover - the caller checked it
            raise ValueError("the payment has no PaymentIntent")
        if refund is None:
            refund = await self._refunds.add(
                Refund(
                    job_id=job_id,
                    payment_id=payment.payment_id,
                    dispute_id=dispute_id,
                    amount_cents=amount_cents,
                    currency=payment.currency,
                    idempotency_key=key,
                )
            )
        number = await self._refunds.start_attempt(refund.id, now)
        if number is None:
            return RefundBlocked.MADE
        return RefundAttempt(
            refund_id=refund.id,
            dispute_id=dispute_id,
            job_id=job_id,
            payment_id=payment.payment_id,
            payment_intent_id=payment.payment_intent_id,
            amount_cents=refund.amount_cents,
            currency=refund.currency,
            idempotency_key=key,
            number=number,
        )

    async def failed(self, attempt: RefundAttempt, code: str) -> None:
        """Ends the attempt as failed with `code` (cut to the column), unless a later one
        started or the refund was stored."""
        await self._refunds.mark_failed(
            attempt.refund_id, attempt.number, code[:REFUND_ERROR_CODE_LENGTH]
        )

    async def created(self, attempt: RefundAttempt, stripe_refund_id: str) -> bool:
        """Stores the refund Stripe made; False when the row holds one already."""
        return await self._refunds.mark_created(attempt.refund_id, stripe_refund_id)

    async def of_dispute(self, dispute_id: uuid.UUID) -> RefundOut | None:
        refund = await self._refunds.of_dispute(dispute_id)
        return None if refund is None else RefundOut.model_validate(refund)


def _payment_facts(payment: Payment) -> PaymentFacts:
    return PaymentFacts(
        payment_id=payment.id,
        payment_intent_id=payment.stripe_payment_intent_id,
        currency=payment.currency,
        customer_total_cents=payment.customer_total_cents,
        pro_payout_cents=payment.pro_payout_cents,
    )


def _in_flight(refund: Refund, now: datetime, stuck_after: timedelta) -> bool:
    """An attempt was stamped, has no outcome yet, and is too recent to be lost."""
    return (
        refund.status is RefundStatus.PENDING
        and refund.last_error_code is None
        and refund.requested_at is not None
        and now - refund.requested_at < stuck_after
    )


class RefundNeedsReviewError(Exception):
    """Stripe's refunds for the dispute cannot be matched with its row: nothing is created.
    `reason` is a fixed word for the log."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


async def make_refund(stripe: StripeRefunds, attempt: RefundAttempt) -> RefundFacts:
    """The refund in Stripe, found (a retry) or created (see the module doc). StripeCallError
    for Stripe's own failures; RefundNeedsReviewError when nothing may be created."""
    if attempt.number > 1:
        found = await stripe.list_refunds(attempt.payment_intent_id)
        if not found.complete:
            raise RefundNeedsReviewError("listing_incomplete")
        ours = [fact for fact in found.refunds if fact.dispute_id == str(attempt.dispute_id)]
        live = [fact for fact in ours if fact.live]
        if len(live) > 1:
            raise RefundNeedsReviewError("several_refunds")
        if live:
            return _fitting(live[0], attempt)
        if ours:
            # The dispute's only refunds failed or were canceled: refunding again is staff's call.
            raise RefundNeedsReviewError("refund_not_live")
    made = await stripe.create_refund(
        payment_intent_id=attempt.payment_intent_id,
        # From the row committed before the call, never from a request.
        amount_cents=attempt.amount_cents,
        metadata={"dispute_id": str(attempt.dispute_id), "job_id": str(attempt.job_id)},
        idempotency_key=attempt.idempotency_key,
    )
    return _fitting(made, attempt)


def _fitting(made: RefundFacts, attempt: RefundAttempt) -> RefundFacts:
    """The refund if it is the one the row describes; else nothing is stored for it."""
    if (
        made.amount_cents != attempt.amount_cents
        or made.currency != attempt.currency
        or made.dispute_id != str(attempt.dispute_id)
        or not made.live
    ):
        raise RefundNeedsReviewError("refund_mismatch")
    return made
