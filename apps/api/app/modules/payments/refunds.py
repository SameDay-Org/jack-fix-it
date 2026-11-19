"""The Stripe step of a refund to the customer (#76): found again or created, never twice, and
read again until Stripe finishes it.

The caller (disputes.resolution) commits the refund row and the attempt before calling
`make_refund`, with no transaction open, and stores what it returns. An attempt after the first
may follow a lost answer: it first lists the PaymentIntent's refunds and adopts the one made
for the row (metadata dispute_id and refund_key), if it fits the row (amount, currency),
whatever Stripe's status of it. More than one, one that does not fit, or a listing with further
pages creates nothing (RefundNeedsReviewError: staff look in Stripe). Otherwise the refund is
created for the row's amount with the row's idempotency key, the same for every attempt, so
Stripe itself answers a repeated create with the first one's refund while it keeps the key.

A dispute holds one refund row that is not abandoned. Staff abandon one Stripe refused for good,
or failed, once Stripe shows no refund of the dispute that could still move money
(disputes.refund_repair, #434); the dispute's next refund then takes a new row and key
(`dispute:<id>:refund:<n>`, dispute_refund_key), so Stripe never answers it with the abandoned
one's stored answer, and its metadata refund_key keeps a retry's lookup from ever adopting the
abandoned one's refund. The dispute's first refund carries no refund_key (made before #434):
only it may be matched without one.

Once Stripe answered with a refund, its id and Stripe's status of it are stored (`observe`),
and no attempt is ever started again for the row: Stripe holds the refund. Created is not done
(#433 round 1): the money is back only when Stripe says `succeeded`. Until then the refund is
read again by its stored id (`recheck_refund`: an admin's retry, or Stripe's refund events).
Stripe failing or canceling it is final for this row: staff repair it (#434).
"""

import uuid
from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.stripe_errors import StripeRejectedError
from app.integrations.stripe_refunds import RefundFacts, StripeRefunds
from app.modules.payments.models import (
    REFUND_ERROR_CODE_LENGTH,
    STRIPE_RANK_DEAD,
    STRIPE_RANK_SUCCEEDED,
    STRIPE_REFUND_DEAD,
    STRIPE_REFUND_SUCCEEDED,
    Payment,
    Refund,
    RefundStatus,
    stripe_status_rank,
)
from app.modules.payments.repository import PaymentRepository, RefundRepository, TransferRepository
from app.modules.payments.schemas import PaymentSummaryOut, RefundOut

# last_error_code of a refund whose Stripe records cannot be matched with its row.
REFUND_NEEDS_REVIEW: Final = "refund_needs_review"
# Stripe's statuses of a refund that will never give the money back (staff see refund_failed).
STRIPE_REFUND_FAILED: Final = STRIPE_REFUND_DEAD
# The longest error code kept for a refund (the row's last_error_code, and its audit rows).
REFUND_CODE_LENGTH: Final = REFUND_ERROR_CODE_LENGTH


def dispute_refund_key(dispute_id: uuid.UUID, generation: int = 1) -> str:
    """The same key for every attempt of the dispute's `generation`-th refund (AGENTS.md
    "Money": every refund carries a deterministic idempotency key): the first is
    `dispute:<id>:refund`, the n-th after staff abandoned the earlier ones (#434)
    `dispute:<id>:refund:<n>`. Unique on the row."""
    base = f"dispute:{dispute_id}:refund"
    return base if generation == 1 else f"{base}:{generation}"


def made_for(fact: RefundFacts, dispute_id: uuid.UUID, key: str) -> bool:
    """Whether Stripe's refund was made for the refund row of this dispute and key: its
    metadata names both (a refund without refund_key counts for the dispute's first row only,
    made before rows carried it)."""
    if fact.dispute_id != str(dispute_id):
        return False
    if fact.refund_key is None:
        return key == dispute_refund_key(dispute_id)
    return fact.refund_key == key


@dataclass(frozen=True)
class DisputeRefund:
    """A dispute's refund row as the disputes module reads it, with the decision it carries
    out. Copied from the row: plain values that outlive the transaction."""

    refund_id: uuid.UUID
    dispute_id: uuid.UUID
    job_id: uuid.UUID
    payment_id: uuid.UUID
    amount_cents: int
    currency: str
    # The decision, written once with the row: who took it, the pro's part, the note.
    initiated_by: uuid.UUID
    pro_release_cents: int
    resolution_note: str
    status: RefundStatus
    stripe_refund_id: str | None
    stripe_status: str | None
    attempts: int
    idempotency_key: str
    last_error_code: str | None
    last_error_definitive: bool
    requested_at: datetime | None

    @property
    def refused_for_good(self) -> bool:
        """Its last attempt failed with Stripe's definitive answer to the create: the same
        key gets the same refusal, so it can never make a refund (#434)."""
        return self.status is RefundStatus.FAILED and self.last_error_definitive

    @property
    def last_attempt_failed(self) -> bool:
        """Its last attempt ended failed, with no Stripe refund stored."""
        return self.status is RefundStatus.FAILED

    @property
    def created_then_dead(self) -> bool:
        """Stripe accepted it and its stored status is failed or canceled (terminal); a caller
        that acts on it reads Stripe again first."""
        return self.status is RefundStatus.CREATED and self.dead

    @property
    def abandoned(self) -> bool:
        """Staff gave it up (#434): it fixes nothing any more."""
        return self.status is RefundStatus.ABANDONED

    def in_flight(self, now: datetime, stuck_after: timedelta) -> bool:
        """An attempt was stamped, has no outcome yet, and is too recent to be taken for lost."""
        return (
            self.status is RefundStatus.PENDING
            and self.last_error_code is None
            and self.requested_at is not None
            and now - self.requested_at < stuck_after
        )

    @property
    def succeeded(self) -> bool:
        return self.stripe_status == STRIPE_REFUND_SUCCEEDED

    @property
    def dead(self) -> bool:
        """Stripe failed or canceled it: final for this row (staff repair, #434)."""
        return self.stripe_status in STRIPE_REFUND_DEAD

    @property
    def ids(self) -> dict[str, str]:
        """For logs: ids only."""
        return {
            "refund_id": str(self.refund_id),
            "dispute_id": str(self.dispute_id),
            "job_id": str(self.job_id),
        }


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
    initiated_by: uuid.UUID

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


@dataclass(frozen=True)
class Observed:
    """Stripe's status of a refund as the row holds it after a read (RefundLedger.observe):
    the read's, or the row's when the read is older than it. `changed`: new for the row."""

    status: str
    changed: bool

    @property
    def succeeded(self) -> bool:
        return stripe_status_rank(self.status) == STRIPE_RANK_SUCCEEDED

    @property
    def dead(self) -> bool:
        return stripe_status_rank(self.status) == STRIPE_RANK_DEAD


@dataclass(frozen=True)
class RefundDecision:
    """What the admin decided, as the refund row keeps it: computed by the caller from the
    frozen amounts (never from the request), and the admin's note."""

    initiated_by: uuid.UUID
    amount_cents: int
    pro_release_cents: int
    resolution_note: str


class RefundBlocked(StrEnum):
    """Why no attempt was started for a dispute's refund."""

    # A refund for another decision (amount or split) was attempted: Stripe may hold it.
    ANOTHER_DECISION = "another_decision"
    # An attempt with no outcome yet is under way (or too recent to be taken for lost).
    IN_FLIGHT = "in_flight"
    # Stripe failed or canceled the refund it holds: nothing more is attempted (#434).
    STRIPE_FAILED = "stripe_failed"


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
        """Whether the dispute has a refund that is not abandoned (one was attempted, and staff
        did not give it up); its row, if any, stays locked until the transaction ends."""
        return await self._refunds.current_of_dispute_for_update(dispute_id) is not None

    async def locked_of_dispute(self, dispute_id: uuid.UUID) -> DisputeRefund | None:
        """The dispute's refund that is not abandoned, locked until the transaction ends, read
        as last committed. Take the job's lock first."""
        refund = await self._refunds.current_of_dispute_for_update(dispute_id)
        return None if refund is None else _dispute_refund(refund)

    async def all_of_dispute(self, dispute_id: uuid.UUID) -> list[DisputeRefund]:
        """Every refund row of the dispute, abandoned ones included, unlocked."""
        return [_dispute_refund(row) for row in await self._refunds.all_of_dispute(dispute_id)]

    async def abandon(self, refund: DisputeRefund) -> bool:
        """Staff give the refund up (#434); False when it was abandoned already. The caller
        holds its lock (locked_of_dispute), checked it cannot move money, and commits it with
        the audit row."""
        return await self._refunds.mark_abandoned(refund.refund_id)

    async def by_stripe_id(self, stripe_refund_id: str) -> DisputeRefund | None:
        """The dispute refund holding this Stripe refund, abandoned or not, unlocked; None for
        any other."""
        refund = await self._refunds.by_stripe_id(stripe_refund_id)
        return None if refund is None or refund.dispute_id is None else _dispute_refund(refund)

    async def failed_of_disputes(self, dispute_ids: Collection[uuid.UUID]) -> set[uuid.UUID]:
        """The disputes among these whose refund Stripe failed or canceled, in one statement."""
        return await self._refunds.dead_of_disputes(dispute_ids)

    async def hold_for_reconciliation(self, dispute_id: uuid.UUID, now: datetime) -> int:
        """Stripe made, or still holds, a refund for the dispute that its abandoned or failed
        rows do not show (#450 round 2): those rows hold the job's payout from now on, until
        staff reconcile it. Returns how many rows hold it. The caller holds the job's and the
        dispute's locks, and commits it before the event is acknowledged."""
        return await self._refunds.hold_for_reconciliation(dispute_id, now)

    async def held_for_reconciliation(self, dispute_ids: Collection[uuid.UUID]) -> set[uuid.UUID]:
        """The disputes among these whose payout is held for staff to reconcile, in one
        statement."""
        return await self._refunds.held_for_reconciliation(dispute_ids)

    async def start_attempt(
        self,
        *,
        dispute_id: uuid.UUID,
        job_id: uuid.UUID,
        payment: PaymentFacts,
        decision: RefundDecision,
        now: datetime,
        stuck_after: timedelta,
    ) -> RefundAttempt | RefundBlocked | DisputeRefund:
        """The dispute's refund row (created now with the decision, or the one an earlier
        attempt left) locked, and a new attempt stamped on it. A row Stripe already holds a
        refund for comes back as is, to be read again (never a new attempt). A new row takes the
        key of the dispute's next refund: the first, or the one after those staff abandoned.
        The caller holds the job's lock and commits before calling Stripe."""
        refund = await self._refunds.current_of_dispute_for_update(dispute_id)
        if refund is not None and (
            refund.amount_cents != decision.amount_cents
            or refund.pro_release_cents != decision.pro_release_cents
        ):
            return RefundBlocked.ANOTHER_DECISION
        if refund is not None and refund.stripe_refund_id is not None:
            held = _dispute_refund(refund)
            return RefundBlocked.STRIPE_FAILED if held.dead else held
        if refund is not None and _dispute_refund(refund).in_flight(now, stuck_after):
            return RefundBlocked.IN_FLIGHT
        if payment.payment_intent_id is None:  # pragma: no cover - the caller checked it
            raise ValueError("the payment has no PaymentIntent")
        if refund is None:
            generation = await self._refunds.abandoned_of_dispute(dispute_id) + 1
            key = dispute_refund_key(dispute_id, generation)
            refund = await self._refunds.add(
                Refund(
                    job_id=job_id,
                    payment_id=payment.payment_id,
                    dispute_id=dispute_id,
                    amount_cents=decision.amount_cents,
                    currency=payment.currency,
                    idempotency_key=key,
                    initiated_by=decision.initiated_by,
                    pro_release_cents=decision.pro_release_cents,
                    resolution_note=decision.resolution_note,
                )
            )
        initiated_by = refund.initiated_by
        number = await self._refunds.start_attempt(refund.id, now)
        if number is None or initiated_by is None:  # pragma: no cover - checked above, CHECK
            raise ValueError("the refund cannot take an attempt")
        return RefundAttempt(
            refund_id=refund.id,
            dispute_id=dispute_id,
            job_id=job_id,
            payment_id=payment.payment_id,
            payment_intent_id=payment.payment_intent_id,
            amount_cents=refund.amount_cents,
            currency=refund.currency,
            idempotency_key=refund.idempotency_key,
            number=number,
            initiated_by=initiated_by,
        )

    async def failed(self, attempt: RefundAttempt, code: str, *, definitive: bool = False) -> None:
        """Ends the attempt as failed with `code` (cut to the column), unless a later one
        started or Stripe's refund was stored; `definitive` when it was Stripe's definitive
        answer to the create (#434: only such a refund may be abandoned)."""
        await self._refunds.mark_failed(
            attempt.refund_id,
            attempt.number,
            code[:REFUND_ERROR_CODE_LENGTH],
            definitive=definitive,
        )

    async def observe(self, refund: DisputeRefund, made: RefundFacts) -> Observed:
        """Stores the refund Stripe holds for the row (its id, the first time) and Stripe's
        status of it now, which only moves forward (stripe_status_rank): a read less final than
        the row's was taken before another reader stored a newer one, and the row's stands. The
        caller read `refund` under its lock in this transaction, and checked `made` fits it
        (refund_fits)."""
        if refund.stripe_status is not None and stripe_status_rank(
            made.status
        ) < stripe_status_rank(refund.stripe_status):
            return Observed(refund.stripe_status, changed=False)
        if not await self._refunds.observe(refund.refund_id, made.refund_id, made.status):
            # Not reached: the row holds another Stripe refund (refund_fits refuses it), or a
            # newer status (checked above, under the row's lock).
            raise RefundNeedsReviewError("another_stripe_refund")
        return Observed(made.status, changed=refund.stripe_status != made.status)

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


def _dispute_refund(refund: Refund) -> DisputeRefund:
    if (
        refund.dispute_id is None
        or refund.initiated_by is None
        or refund.pro_release_cents is None
        or refund.resolution_note is None
    ):  # pragma: no cover - the table's CHECK holds every dispute refund to it
        raise ValueError("a dispute refund without its decision")
    return DisputeRefund(
        refund_id=refund.id,
        dispute_id=refund.dispute_id,
        job_id=refund.job_id,
        payment_id=refund.payment_id,
        amount_cents=refund.amount_cents,
        currency=refund.currency,
        initiated_by=refund.initiated_by,
        pro_release_cents=refund.pro_release_cents,
        resolution_note=refund.resolution_note,
        status=refund.status,
        stripe_refund_id=refund.stripe_refund_id,
        stripe_status=refund.stripe_status,
        attempts=refund.attempts,
        idempotency_key=refund.idempotency_key,
        last_error_code=refund.last_error_code,
        last_error_definitive=refund.last_error_definitive,
        requested_at=refund.requested_at,
    )


class RefundCreateRejectedError(StripeRejectedError):
    """Stripe's 4xx answer to the refund CREATE itself (make_refund), not to the retry's lookup
    or to a read (#450 round 2): with Stripe's code, only this answer says that the create under
    the row's key can never make a refund (last_error_definitive). A lookup that fails says
    nothing about an earlier create, whose outcome stays uncertain."""


class RefundNeedsReviewError(Exception):
    """Stripe's refunds for the dispute cannot be matched with its row: nothing is created or
    stored. `reason` is a fixed word for the log."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


async def make_refund(stripe: StripeRefunds, attempt: RefundAttempt) -> RefundFacts:
    """The refund in Stripe, found (a retry) or created (see the module doc), whatever its
    status. StripeCallError for Stripe's own failures (RefundCreateRejectedError when it is the
    create that Stripe refused); RefundNeedsReviewError when nothing may be created."""
    if attempt.number > 1:
        found = await stripe.list_refunds(attempt.payment_intent_id)
        if not found.complete:
            raise RefundNeedsReviewError("listing_incomplete")
        ours = [
            fact
            for fact in found.refunds
            if made_for(fact, attempt.dispute_id, attempt.idempotency_key)
        ]
        if len(ours) > 1:
            raise RefundNeedsReviewError("several_refunds")
        if ours:
            return _fitting(
                ours[0],
                attempt.dispute_id,
                attempt.idempotency_key,
                attempt.amount_cents,
                attempt.currency,
            )
    try:
        made = await stripe.create_refund(
            payment_intent_id=attempt.payment_intent_id,
            # From the row committed before the call, never from a request.
            amount_cents=attempt.amount_cents,
            metadata={
                "dispute_id": str(attempt.dispute_id),
                "job_id": str(attempt.job_id),
                "refund_key": attempt.idempotency_key,
            },
            idempotency_key=attempt.idempotency_key,
        )
    except StripeRejectedError as error:
        # The create's own refusal, told apart from the lookup's above (round 2).
        raise RefundCreateRejectedError(request_id=error.request_id, code=error.code) from None
    return _fitting(
        made, attempt.dispute_id, attempt.idempotency_key, attempt.amount_cents, attempt.currency
    )


async def recheck_refund(stripe: StripeRefunds, refund: DisputeRefund) -> RefundFacts:
    """The row's Stripe refund as Stripe holds it now, read by its stored id (never from an
    event's payload). StripeCallError for Stripe's own failures; RefundNeedsReviewError when it
    no longer fits the row."""
    if refund.stripe_refund_id is None:  # pragma: no cover - callers pass a held refund
        raise ValueError("the refund has no Stripe refund to read")
    read = await stripe.retrieve_refund(refund.stripe_refund_id)
    return refund_fits(read, refund)


def refund_fits(read: RefundFacts, refund: DisputeRefund) -> RefundFacts:
    """`read` if it is the Stripe refund the row holds (or may hold: none stored yet)."""
    if refund.stripe_refund_id is not None and read.refund_id != refund.stripe_refund_id:
        raise RefundNeedsReviewError("refund_mismatch")
    return _fitting(
        read, refund.dispute_id, refund.idempotency_key, refund.amount_cents, refund.currency
    )


def _fitting(
    made: RefundFacts, dispute_id: uuid.UUID, key: str, amount_cents: int, currency: str
) -> RefundFacts:
    """The refund if it is the one the row describes; else nothing is stored for it."""
    if (
        made.amount_cents != amount_cents
        or made.currency != currency
        or not made_for(made, dispute_id, key)
    ):
        raise RefundNeedsReviewError("refund_mismatch")
    return made
