"""The refund of a cancelled job (#69): made by the worker through #433's Stripe step.

The cancellations module commits the cancel together with the refund's row, its intent: the
amount computed on the server, the key, no attempt yet. After that commit it queues
`refund_cancellation` (cancel_refund_tasks.py). From there it goes as a dispute's refund does
(payments.refunds), with the worker in place of the admin:

1. Under the row's lock:
   - a refund Stripe already holds is read again by its stored id, never attempted again;
   - a refund Stripe succeeded, failed or canceled, refused for good (its definitive answer to
     the create), or whose records cannot be matched, is final, and left for staff when it
     did not succeed;
   - an attempt with no outcome yet, too recent to be taken for lost, is another worker's.
   Otherwise an attempt is stamped (its number and start time) and COMMITTED before Stripe is
   called: a lost answer leaves a row that says a refund may have been made.
2. Stripe, with no transaction open: make_refund or recheck_refund. A retry lists the
   PaymentIntent's refunds first and adopts the one made for this row (metadata refund_key,
   no dispute).
3. Under the row's lock again, one of two outcomes:
   - Stripe's refund and its status are stored, forward only (RefundLedger.observe);
   - or the attempt ends failed with Stripe's code. It is definitive only when Stripe
     refused the create itself with a code that says this charge can never be refunded
     under the key (payments.refunds.REFUND_REFUSED_CODES, the rule a dispute's refund
     follows since #450). Any other answer to the create (an expired API key, a parameter
     Stripe does not know, a key still in use), like any answer to the retry's lookup,
     says nothing final: the row stays for the sweep, which lists first and adopts or
     creates.

The money is back only at `succeeded`; until then the cancellation shows its refund pending.
Stripe's refund events reach cancel_refund_event (from the refund webhook handler), which reads
the refund again by its stored id and stores what Stripe says. A refund that will not go
through is logged as an ERROR for staff (`cancel_refund_failed`) and never retried: the same
key would get the same answer. The sweep (retry_cancel_refunds) takes every row left without
Stripe's answer once REFUND_STUCK_PENDING_MINUTES have passed since its latest try: a task
never queued, a worker that died, Stripe unavailable, a lost answer.

The key is `cancel:<job id>:refund`: one refund per cancelled job (the column is unique).
Nothing here touches the job: it is cancelled already, and a cancelled job is never paid out
(payments.transfers releases confirmed jobs only). Logs carry ids, codes and statuses only.
"""

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.stripe_errors import StripeCallError, StripeUnavailableError
from app.integrations.stripe_refunds import RefundFacts, StripeRefunds
from app.modules.payments.models import (
    STRIPE_REFUND_DEAD,
    STRIPE_REFUND_SUCCEEDED,
    Refund,
    RefundStatus,
)
from app.modules.payments.refunds import (
    REFUND_CODE_LENGTH,
    REFUND_NEEDS_REVIEW,
    PaymentFacts,
    RefundCreateRejectedError,
    RefundLedger,
    RefundNeedsReviewError,
    make_refund,
    recheck_refund,
    refund_fits,
)
from app.modules.payments.repository import PaymentRepository, RefundRepository

logger = logging.getLogger(__name__)

CANCEL_REFUND_PREFIX: Final = "cancel:"


def utc_now() -> datetime:
    return datetime.now(UTC)


def cancel_refund_key(job_id: uuid.UUID) -> str:
    """The same key for every attempt of the cancelled job's refund (AGENTS.md "Money")."""
    return f"{CANCEL_REFUND_PREFIX}{job_id}:refund"


class CancelRefundState(StrEnum):
    """A cancelled job's refund in plain terms, as its customer is told."""

    # Nothing to refund: the fee took the whole payment.
    NONE = "none"
    # On its way: Stripe has not said the money is back yet.
    PENDING = "pending"
    # Stripe says the money is back on the customer's payment method.
    SUCCEEDED = "succeeded"
    # It did not go through; staff look into it.
    FAILED = "failed"


@dataclass(frozen=True)
class CancelRefund:
    """A cancelled job's refund row, copied: plain values that outlive the transaction."""

    refund_id: uuid.UUID
    job_id: uuid.UUID
    payment_id: uuid.UUID
    amount_cents: int
    currency: str
    status: RefundStatus
    stripe_refund_id: str | None
    stripe_status: str | None
    attempts: int
    idempotency_key: str
    last_error_code: str | None
    last_error_definitive: bool
    requested_at: datetime | None

    @property
    def dispute_id(self) -> None:
        """A cancellation's refund settles no dispute."""
        return None

    @property
    def ids(self) -> dict[str, str]:
        return {"refund_id": str(self.refund_id), "job_id": str(self.job_id)}

    @property
    def state(self) -> CancelRefundState:
        if self.stripe_status == STRIPE_REFUND_SUCCEEDED:
            return CancelRefundState.SUCCEEDED
        if self.final:
            return CancelRefundState.FAILED
        return CancelRefundState.PENDING

    @property
    def final(self) -> bool:
        """Nothing more will be attempted: Stripe finished it (succeeded, failed, canceled),
        refused the create for good, or its records cannot be matched (staff look)."""
        return (
            self.stripe_status == STRIPE_REFUND_SUCCEEDED
            or self.stripe_status in STRIPE_REFUND_DEAD
            or (
                self.status is RefundStatus.FAILED
                and (self.last_error_definitive or self.last_error_code == REFUND_NEEDS_REVIEW)
            )
        )

    def in_flight(self, now: datetime, stuck_after: timedelta) -> bool:
        """An attempt was stamped, has no outcome yet, and is too recent to be taken for lost."""
        return (
            self.status is RefundStatus.PENDING
            and self.last_error_code is None
            and self.requested_at is not None
            and now - self.requested_at < stuck_after
        )


@dataclass(frozen=True)
class CancelAttempt:
    """One Stripe attempt of a cancelled job's refund, copied before its commit."""

    refund_id: uuid.UUID
    job_id: uuid.UUID
    payment_intent_id: str
    amount_cents: int
    currency: str
    idempotency_key: str
    number: int

    @property
    def dispute_id(self) -> None:
        return None

    @property
    def ids(self) -> dict[str, str | int]:
        return {
            "refund_id": str(self.refund_id),
            "job_id": str(self.job_id),
            "attempt": self.number,
        }


class CancelRefundOutcome(StrEnum):
    """What one run of CancelRefunds.make did."""

    # Stripe's refund and its status were stored (whatever the status).
    STORED = "stored"
    # Nothing more to do: finished at Stripe, refused for good, or for staff.
    FINAL = "final"
    # Another worker's attempt is under way.
    IN_FLIGHT = "in_flight"
    # This attempt failed; the sweep tries again unless Stripe's answer was definitive.
    FAILED = "failed"
    # The job has no cancellation refund.
    NOT_FOUND = "not_found"
    # No Stripe key: the sweep tries again later.
    NOT_CONFIGURED = "not_configured"


def _view(row: Refund) -> CancelRefund:
    return CancelRefund(
        refund_id=row.id,
        job_id=row.job_id,
        payment_id=row.payment_id,
        amount_cents=row.amount_cents,
        currency=row.currency,
        status=row.status,
        stripe_refund_id=row.stripe_refund_id,
        stripe_status=row.stripe_status,
        attempts=row.attempts,
        idempotency_key=row.idempotency_key,
        last_error_code=row.last_error_code,
        last_error_definitive=row.last_error_definitive,
        requested_at=row.requested_at,
    )


def is_cancel_refund(row: Refund) -> bool:
    return row.dispute_id is None and row.idempotency_key.startswith(CANCEL_REFUND_PREFIX)


class CancelRefunds:
    def __init__(
        self,
        session: AsyncSession,
        stripe: StripeRefunds | None,
        stuck_after: timedelta,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._session = session
        self._stripe = stripe
        self._stuck_after = stuck_after
        self._clock = clock
        self._refunds = RefundRepository(session)
        self._payments = PaymentRepository(session)
        self._ledger = RefundLedger(session)

    # --- For the cancellations module, in its transaction ----------------------------------

    async def add_intent(
        self, job_id: uuid.UUID, payment: PaymentFacts, amount_cents: int
    ) -> uuid.UUID:
        """The refund's row, pending with no attempt, in the caller's transaction (flushed: a
        second row under the job's key surfaces here). The amount comes from the caller's
        server-side split, never from a request."""
        row = await self._refunds.add(
            Refund(
                job_id=job_id,
                payment_id=payment.payment_id,
                amount_cents=amount_cents,
                currency=payment.currency,
                idempotency_key=cancel_refund_key(job_id),
            )
        )
        return row.id

    async def of_job(self, job_id: uuid.UUID) -> CancelRefund | None:
        """The job's cancellation refund as last committed, unlocked; None when there is none."""
        row = await self._refunds.by_key(cancel_refund_key(job_id))
        return None if row is None else _view(row)

    # --- The worker ------------------------------------------------------------------------

    async def due(self, limit: int) -> list[uuid.UUID]:
        """The jobs whose refund is left without Stripe's answer past the stuck window, least
        recently tried first."""
        try:
            return await self._refunds.due_cancel_refunds(
                CANCEL_REFUND_PREFIX, REFUND_NEEDS_REVIEW, self._clock() - self._stuck_after, limit
            )
        finally:
            await self._session.rollback()

    async def make(self, job_id: uuid.UUID) -> CancelRefundOutcome:
        """Steps 1 to 3 of the module doc for the job's refund. Ends every transaction it
        opens; raises only for the database."""
        try:
            started = await self._start(job_id)
            if isinstance(started, CancelRefundOutcome):
                return started
            # The attempt outlives whatever happens next, and the row's lock ends here.
            await self._session.commit()
            stripe = self._stripe
            if stripe is None:  # pragma: no cover - _start checked it
                return CancelRefundOutcome.NOT_CONFIGURED
            try:
                if isinstance(started, CancelAttempt):
                    read = await make_refund(stripe, started)
                else:
                    read = await recheck_refund(stripe, started)
            except RefundNeedsReviewError as error:
                await self._end_failed(started, REFUND_NEEDS_REVIEW)
                logger.error(
                    "cancel_refund_needs_review", extra={**started.ids, "reason": error.reason}
                )
                return CancelRefundOutcome.FAILED
            except StripeCallError as error:
                # Definitive only for the create's own refusal of the charge, by the shared
                # allowlist (#450 round 4): any other coded 4xx may pass, and is retried.
                definitive = isinstance(error, RefundCreateRejectedError) and error.definitive
                await self._end_failed(started, error.code or type(error).__name__, definitive)
                extra = {
                    **started.ids,
                    "stripe_request_id": error.request_id,
                    "stripe_code": error.code,
                }
                if definitive:
                    logger.error("cancel_refund_failed", extra=extra)
                elif isinstance(error, StripeUnavailableError):
                    logger.warning("cancel_refund_stripe_unavailable", extra=extra)
                else:
                    logger.error("cancel_refund_stripe_rejected", extra=extra)
                return CancelRefundOutcome.FAILED
            return await self._store(job_id, read)
        finally:
            await self._session.rollback()

    async def _start(self, job_id: uuid.UUID) -> CancelAttempt | CancelRefund | CancelRefundOutcome:
        """Step 1, under the row's lock: an attempt stamped (not committed yet), the refund
        Stripe holds to read again, or why nothing is to be done."""
        row = await self._refunds.by_key_for_update(cancel_refund_key(job_id))
        if row is None:
            return CancelRefundOutcome.NOT_FOUND
        refund = _view(row)
        if refund.final:
            return CancelRefundOutcome.FINAL
        if self._stripe is None:
            logger.warning("cancel_refund_stripe_not_configured", extra=refund.ids)
            return CancelRefundOutcome.NOT_CONFIGURED
        if refund.stripe_refund_id is not None:
            return refund
        now = self._clock()
        if refund.in_flight(now, self._stuck_after):
            return CancelRefundOutcome.IN_FLIGHT
        intent = await self._payments.intent_of(refund.payment_id)
        number = await self._refunds.start_attempt(refund.refund_id, now)
        if intent is None or number is None:  # pragma: no cover - checked at the cancel
            raise ValueError("the refund cannot take an attempt")
        return CancelAttempt(
            refund_id=refund.refund_id,
            job_id=refund.job_id,
            payment_intent_id=intent,
            amount_cents=refund.amount_cents,
            currency=refund.currency,
            idempotency_key=refund.idempotency_key,
            number=number,
        )

    async def _end_failed(
        self, started: CancelAttempt | CancelRefund, code: str, definitive: bool = False
    ) -> None:
        """No refund came back: the attempt ends failed (a read of a held refund leaves the row
        as it is), committed."""
        if isinstance(started, CancelAttempt):
            await self._refunds.mark_failed(
                started.refund_id, started.number, code[:REFUND_CODE_LENGTH], definitive=definitive
            )
            await self._session.commit()

    async def _store(self, job_id: uuid.UUID, read: RefundFacts) -> CancelRefundOutcome:
        """Step 3: Stripe's refund and its status stored under the row's lock, committed."""
        row = await self._refunds.by_key_for_update(cancel_refund_key(job_id))
        if row is None:  # pragma: no cover - refund rows are never deleted
            return CancelRefundOutcome.NOT_FOUND
        refund = _view(row)
        try:
            await apply_read(self._ledger, refund, read)
        except RefundNeedsReviewError as error:
            await self._session.rollback()
            logger.error("cancel_refund_needs_review", extra={**refund.ids, "reason": error.reason})
            return CancelRefundOutcome.FAILED
        await self._session.commit()
        return CancelRefundOutcome.STORED


async def apply_read(ledger: RefundLedger, refund: CancelRefund, read: RefundFacts) -> None:
    """Stores what Stripe says of the refund (`refund` read under its lock), forward only, and
    tells staff when it will not go through. Never commits."""
    observed = await ledger.observe(refund, refund_fits(read, refund))
    extra = {**refund.ids, "stripe_status": observed.status}
    if observed.succeeded:
        logger.info("cancel_refund_succeeded", extra=extra)
    elif observed.dead:
        if observed.changed:
            logger.error("cancel_refund_failed", extra=extra)
    else:
        logger.info("cancel_refund_pending", extra=extra)


async def cancel_refund_of(session: AsyncSession, stripe_refund_id: str) -> CancelRefund | None:
    """The cancelled job's refund holding this Stripe refund, unlocked; None for any other."""
    row = await RefundRepository(session).by_stripe_id(stripe_refund_id)
    return None if row is None or not is_cancel_refund(row) else _view(row)


async def cancel_refund_event(
    session: AsyncSession, stripe: StripeRefunds, refund: CancelRefund, log: dict[str, str]
) -> None:
    """Stripe's refund event for a cancelled job's refund: the refund read again by its stored
    id (before any lock), then stored under the row's lock. Never commits: the worker does."""
    read = await recheck_refund(stripe, refund)
    row = await RefundRepository(session).by_key_for_update(refund.idempotency_key)
    if row is None:  # pragma: no cover - refund rows are never deleted
        return
    held = _view(row)
    await apply_read(RefundLedger(session), held, read)
    logger.info("refund_event_applied", extra={**log, **held.ids})
