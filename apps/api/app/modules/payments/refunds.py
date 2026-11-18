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
from dataclasses import dataclass
from typing import Final

from app.integrations.stripe_refunds import RefundFacts, StripeRefunds

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
