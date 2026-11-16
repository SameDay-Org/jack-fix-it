"""The transfer to the pro once their job is confirmed (D13.3, #68; ADR 0005): the last step
of the money loop.

The customer's payment stays on the platform balance (service.py). When the job is confirmed,
by the customer (#66) or by the 48 h auto-confirm (#67), TransferService.release moves the pro's
share to their Stripe Express account and the job to paid_out. Three callers, one path: the
worker task queued after each confirmation, and the sweep (transfer_tasks.py) for whatever those
left behind. Any number of them, in any order, make one transfer.

release(job_id), in three steps:

1. Under the job's row lock (the one every status change takes), then the transfer row's:
   - the job is confirmed: anything else is left alone (not_confirmed);
   - nothing holds its money back (has_open_hold: the dispute or problem flag of #75);
   - no attempt is under way: a row pending with an attempt stamped less than
     TRANSFER_STUCK_PENDING_MINUTES ago and no outcome is another worker's (in_flight);
   - the job's payment succeeded and froze the same payout as the job did, a positive one;
   - the transfer row exists, or is created now: one per job (unique job_id), with the amount
     copied from the job's frozen pro_payout_cents, never computed from a rate;
   - staff approve the pro now (#41): else the row stays pending with `pro_not_approved`
     (held) and no Stripe call is made, whether or not Stripe still has their payouts enabled;
     the sweep takes the job again once staff approve them again;
   - the pro can be paid out (a Stripe account, payouts enabled): else the row stays pending
     with `payouts_not_enabled` and no Stripe call is made; the sweep takes the job again once
     the pro can.
   Then the attempt (its number and start time) is stamped and COMMITTED: the row, and the fact
   that a create may reach Stripe, are stored before any call, and no transaction or lock is
   held across one.
2. Stripe, with no transaction open. A retry (any attempt after the first) first lists the
   request's transfer group and looks for a transfer whose metadata names the job: exactly one
   that fits the row (amount, currency, destination, not reversed) is adopted, so an answer
   lost in an earlier attempt never leads to a second create, however old the attempt. A
   transfer reversed in Stripe does not count (staff reversed a duplicate); one that was the
   only match creates nothing. More than one live match, one that does not fit, or a listing
   with further pages creates nothing either (`transfer_needs_review`, for staff: they reverse
   the duplicate, or store the transfer on the row as created, and the sweep then moves the
   job to paid_out). Otherwise the transfer is created from the payment's
   charge (source_transaction), for the row's amount, to the pro's account, in the request's
   transfer group, with metadata job_id and the idempotency key `transfer:<job id>`: the same
   key for every attempt of the job, so Stripe itself answers a repeated create with the first
   one's transfer while it keeps the key (24 h).
3. Under the same locks again: the transfer's id is stored (created) and the job moves
   confirmed -> paid_out through JobStateMachine as the system (one job_events row), in one
   transaction.
4. Once that is committed, the transfer is read from Stripe again. A transfer reversed between
   its create and step 3 (its create answer slow to come back) had its transfer.reversed event
   find no row with its id, and that event is processed and gone. So a reversal found now is
   recorded through the webhook's own path (record_reversal); a later event finds the stored
   id itself, and whichever comes second changes nothing. A failed read is logged for staff
   (`transfer_reversal_check_failed`); the transfer stays created.

A Stripe error leaves the job confirmed and the row failed with Stripe's error code (or the
error's class name; never its text) for the next try. Stripe keeps a create's own refusal under
the key too, so until it forgets the key a retry is answered with the same refusal: the sweep
waits TRANSFER_STUCK_PENDING_MINUTES between tries of a job.

Logs carry ids only (the job, the transfer row, the pro's profile, the payment, the request,
Stripe's request id and error code): never an amount, an account id, a charge id or a transfer
id.
"""

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.stripe_errors import StripeCallError, StripeUnavailableError
from app.integrations.stripe_transfers import StripeTransfers, TransferFacts
from app.modules.jobs.service import JobPayoutFacts, JobPayouts
from app.modules.payments.models import (
    MADE_STATUSES,
    TRANSFER_ERROR_CODE_LENGTH,
    Transfer,
    TransferStatus,
)
from app.modules.payments.repository import PaymentRepository, TransferRepository
from app.modules.payments.service import transfer_group
from app.modules.payments.transfer_webhooks import record_reversal
from app.modules.pros.service import ProService

logger = logging.getLogger(__name__)

# last_error_code values of ours, beside Stripe's own codes.
PAYOUTS_NOT_ENABLED: Final = "payouts_not_enabled"
PRO_NOT_APPROVED: Final = "pro_not_approved"
TRANSFER_NEEDS_REVIEW: Final = "transfer_needs_review"


def transfer_idempotency_key(job_id: uuid.UUID) -> str:
    """The same key for every attempt to create this job's transfer (AGENTS.md "Money": every
    transfer carries a deterministic idempotency key)."""
    return f"transfer:{job_id}"


async def has_open_hold(session: AsyncSession, job: JobPayoutFacts) -> bool:
    """Whether something holds the job's money back: an open dispute or problem flag. Such a
    job is never released, by any path.

    TODO(#75): the dispute module fills this in (and keeps held jobs out of the sweep's
    query). Until then nothing can hold a confirmed job: a problem reported in the
    confirmation window moves the job to disputed, which release never touches.
    """
    return False


class ReleaseOutcome(StrEnum):
    """What one release call did."""

    # The transfer was made (created now, or found in Stripe and adopted): the job is paid_out.
    CREATED = "created"
    # The job's transfer was made before this call: nothing to do.
    ALREADY_CREATED = "already_created"
    # The job is not confirmed (or does not exist): not this call's to pay.
    NOT_CONFIRMED = "not_confirmed"
    # Something holds the job's money back (has_open_hold), or staff do not approve the pro
    # now: tried again once that changes.
    HELD = "held"
    # The pro has no Stripe account or their payouts are not enabled: tried again later.
    PAYOUTS_NOT_ENABLED = "payouts_not_enabled"
    # Another worker's attempt is under way.
    IN_FLIGHT = "in_flight"
    # Stripe refused or could not be reached: tried again later.
    FAILED = "failed"
    # Staff must look: the job's payment or amounts do not add up, or Stripe holds transfers
    # for the job that the row cannot be matched with.
    NEEDS_REVIEW = "needs_review"
    # No Stripe secret key (allowed outside staging and production).
    NOT_CONFIGURED = "not_configured"


@dataclass(frozen=True)
class TransferConfig:
    # How long an attempt with no recorded outcome is taken to be under way.
    stuck_after: timedelta

    @classmethod
    def from_settings(cls, settings: Settings) -> "TransferConfig":
        return cls(stuck_after=timedelta(minutes=settings.transfer_stuck_pending_minutes))


@dataclass(frozen=True)
class _Attempt:
    """One Stripe attempt as its steps need it, copied before the transaction that stamped
    it ends."""

    transfer_id: uuid.UUID
    job_id: uuid.UUID
    request_id: uuid.UUID
    payment_id: uuid.UUID
    pro_id: uuid.UUID
    amount_cents: int
    currency: str
    destination: str
    payment_intent_id: str
    number: int

    @property
    def ids(self) -> dict[str, str | int]:
        """For logs: ids and the attempt's number only."""
        return {
            "job_id": str(self.job_id),
            "transfer_id": str(self.transfer_id),
            "payment_id": str(self.payment_id),
            "request_id": str(self.request_id),
            "pro_id": str(self.pro_id),
            "attempt": self.number,
        }


class _NeedsReviewError(Exception):
    """Stripe's transfers for the job cannot be matched with its row: nothing is created.
    `reason` is a fixed word for the log."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _utc_now() -> datetime:
    return datetime.now(UTC)


class TransferService:
    def __init__(
        self,
        session: AsyncSession,
        stripe: StripeTransfers | None,
        config: TransferConfig,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        self._session = session
        self._stripe = stripe
        self._config = config
        self._clock = clock
        self._transfers = TransferRepository(session)
        self._payments = PaymentRepository(session)
        self._pros = ProService(session)
        self._jobs = JobPayouts(session, self._pros)

    async def due(self, limit: int) -> list[uuid.UUID]:
        """Up to `limit` ids of the confirmed jobs the sweep may try now, least recently
        tried first (TransferRepository.due). Unlocked; ends its transaction."""
        job_ids = await self._transfers.due(
            self._jobs.confirmed(),
            self._pros.payable(),
            self._clock() - self._config.stuck_after,
            limit,
        )
        await self._session.rollback()
        return job_ids

    async def release(self, job_id: uuid.UUID) -> ReleaseOutcome:
        """Makes the job's transfer to its pro, once (see the module doc). Ends every
        transaction it opens; a Stripe failure is an outcome, never an exception."""
        if self._stripe is None:
            logger.warning("transfer_stripe_not_configured", extra={"job_id": str(job_id)})
            return ReleaseOutcome.NOT_CONFIGURED
        attempt = await self._prepare(job_id)
        if isinstance(attempt, ReleaseOutcome):
            return attempt
        try:
            made = await self._transfer(self._stripe, attempt)
        except _NeedsReviewError as error:
            await self._end_failed(attempt, TRANSFER_NEEDS_REVIEW)
            logger.error("transfer_needs_review", extra={**attempt.ids, "reason": error.reason})
            return ReleaseOutcome.NEEDS_REVIEW
        except StripeCallError as error:
            # Its code, or its class: never its text (stripe_errors.py carries none).
            code = (error.code or type(error).__name__)[:TRANSFER_ERROR_CODE_LENGTH]
            await self._end_failed(attempt, code)
            logger.error(
                "transfer_stripe_unavailable"
                if isinstance(error, StripeUnavailableError)
                else "transfer_stripe_rejected",
                extra={
                    **attempt.ids,
                    "stripe_request_id": error.request_id,
                    "stripe_code": error.code,
                },
            )
            return ReleaseOutcome.FAILED
        return await self._settle(self._stripe, attempt, made)

    async def _prepare(self, job_id: uuid.UUID) -> _Attempt | ReleaseOutcome:
        """Step 1: the checks under the job's lock, the row, and the attempt stamped and
        committed. An outcome when no Stripe call is to be made."""
        job = await self._jobs.locked(job_id)
        if job is None or not job.confirmed:
            return await self._leave(ReleaseOutcome.NOT_CONFIRMED)
        ids = {"job_id": str(job.job_id), "pro_id": str(job.pro_id)}
        if await has_open_hold(self._session, job):
            logger.info("transfer_held", extra=ids)
            return await self._leave(ReleaseOutcome.HELD)
        transfer = await self._transfers.get_of_job_for_update(job.job_id)
        if transfer is not None and transfer.status in MADE_STATUSES:
            return await self._already_made(job, transfer)
        if transfer is not None and self._in_flight(transfer):
            return await self._leave(ReleaseOutcome.IN_FLIGHT)
        payment = await self._payments.succeeded_of_quote(job.quote_id)
        if payment is None or payment.stripe_payment_intent_id is None:
            logger.error("transfer_payment_missing", extra=ids)
            return await self._leave(ReleaseOutcome.NEEDS_REVIEW)
        # The job's frozen payout, never a rate: it must be what the payment froze too, and
        # what an earlier release of this job stored.
        amount_cents = job.pro_payout_cents
        if (
            amount_cents <= 0
            or amount_cents != payment.pro_payout_cents
            or (transfer is not None and transfer.amount_cents != amount_cents)
        ):
            logger.error("transfer_amount_mismatch", extra={**ids, "payment_id": str(payment.id)})
            return await self._leave(ReleaseOutcome.NEEDS_REVIEW)
        if transfer is None:
            transfer = await self._transfers.add(
                Transfer(
                    job_id=job.job_id,
                    payment_id=payment.id,
                    pro_id=job.pro_id,
                    amount_cents=amount_cents,
                    currency=payment.currency,
                    idempotency_key=transfer_idempotency_key(job.job_id),
                )
            )
        account = await self._pros.payout_account_of_profile(job.pro_id)
        if account is not None and not account.approved:
            # Staff rejected the pro after the job, or never approved them: Stripe may still
            # have their payouts enabled, so this is the check that keeps the money here.
            await self._transfers.hold_back(transfer.id, PRO_NOT_APPROVED)
            await self._session.commit()
            logger.warning("transfer_pro_not_approved", extra=ids)
            return ReleaseOutcome.HELD
        destination = None if account is None else account.stripe_account_id
        if account is None or destination is None or not account.payouts_enabled:
            await self._transfers.hold_back(transfer.id, PAYOUTS_NOT_ENABLED)
            await self._session.commit()
            logger.warning("transfer_payouts_not_enabled", extra=ids)
            return ReleaseOutcome.PAYOUTS_NOT_ENABLED
        number = await self._transfers.start_attempt(transfer.id, self._clock())
        if number is None:  # pragma: no cover - the row is locked since its status was read
            return await self._leave(ReleaseOutcome.ALREADY_CREATED)
        attempt = _Attempt(
            transfer_id=transfer.id,
            job_id=job.job_id,
            request_id=job.request_id,
            payment_id=payment.id,
            pro_id=job.pro_id,
            amount_cents=amount_cents,
            currency=payment.currency,
            destination=destination,
            payment_intent_id=payment.stripe_payment_intent_id,
            number=number,
        )
        # Before any Stripe call: the row and its attempt outlive whatever happens next, and
        # the locks end here.
        await self._session.commit()
        return attempt

    def _in_flight(self, transfer: Transfer) -> bool:
        """An attempt was stamped, has no outcome yet, and is too recent to be lost."""
        return (
            transfer.status is TransferStatus.PENDING
            and transfer.last_error_code is None
            and transfer.requested_at is not None
            and self._clock() - transfer.requested_at < self._config.stuck_after
        )

    async def _already_made(self, job: JobPayoutFacts, transfer: Transfer) -> ReleaseOutcome:
        """The row holds a transfer Stripe made, and the job is still confirmed: a created one
        only misses the job's move (its transaction is the one that stores the transfer, so
        this is a row staff repaired by hand after a review; the sweep reads these); a reversed
        one is staff's."""
        ids = {"job_id": str(job.job_id), "transfer_id": str(transfer.id)}
        if transfer.status is not TransferStatus.CREATED:
            logger.error("transfer_reversed_job_confirmed", extra=ids)
            return await self._leave(ReleaseOutcome.NEEDS_REVIEW)
        await self._jobs.paid_out(job.job_id)
        await self._session.commit()
        logger.warning("transfer_job_paid_out_late", extra=ids)
        return ReleaseOutcome.ALREADY_CREATED

    async def _transfer(self, stripe: StripeTransfers, attempt: _Attempt) -> TransferFacts:
        """Step 2: the job's transfer in Stripe, found (a retry) or created. No transaction
        is open."""
        group = transfer_group(attempt.request_id)
        if attempt.number > 1:
            found = await stripe.list_transfers(group)
            if not found.complete:
                raise _NeedsReviewError("listing_incomplete")
            ours = [fact for fact in found.transfers if fact.job_id == str(attempt.job_id)]
            live = [fact for fact in ours if not fact.reversed]
            if len(live) > 1:
                raise _NeedsReviewError("several_transfers")
            if live:
                return _fitting(live[0], attempt)
            if ours:
                # The job's only transfers were reversed: paying again is staff's call.
                raise _NeedsReviewError("transfer_reversed")
        charge_id = await stripe.charge_of_payment_intent(attempt.payment_intent_id)
        created = await stripe.create_transfer(
            # From the row committed in step 1, never from a request or a rate.
            amount_cents=attempt.amount_cents,
            currency=attempt.currency,
            destination=attempt.destination,
            transfer_group=group,
            source_transaction=charge_id,
            metadata={"job_id": str(attempt.job_id)},
            idempotency_key=transfer_idempotency_key(attempt.job_id),
        )
        return _fitting(created, attempt)

    async def _settle(
        self, stripe: StripeTransfers, attempt: _Attempt, made: TransferFacts
    ) -> ReleaseOutcome:
        """Step 3: the transfer's id stored and the job paid_out, in one transaction; then
        step 4."""
        job = await self._jobs.locked(attempt.job_id)
        if not await self._transfers.mark_created(attempt.transfer_id, made.transfer_id):
            # Another attempt of this job stored it first: the same transfer (one key).
            return await self._leave(ReleaseOutcome.ALREADY_CREATED)
        if job is not None and job.confirmed:
            await self._jobs.paid_out(job.job_id)
        else:  # pragma: no cover - only release moves a confirmed job, under this lock
            logger.error("transfer_created_job_not_confirmed", extra=attempt.ids)
        await self._session.commit()
        logger.info("transfer_created", extra={**attempt.ids, "stripe_request_id": made.request_id})
        await self._check_reversal(stripe, attempt, made.transfer_id)
        return ReleaseOutcome.CREATED

    async def _check_reversal(
        self, stripe: StripeTransfers, attempt: _Attempt, stripe_transfer_id: str
    ) -> None:
        """Step 4: the stored transfer read again, a reversal recorded (see the module doc).
        No transaction is open during the read."""
        try:
            current = await stripe.retrieve_transfer(stripe_transfer_id)
        except StripeCallError as error:
            logger.error(
                "transfer_reversal_check_failed",
                extra={
                    **attempt.ids,
                    "stripe_request_id": error.request_id,
                    "stripe_code": error.code,
                },
            )
            return
        if current.reversed:
            await record_reversal(self._session, stripe_transfer_id, attempt.ids)
            await self._session.commit()

    async def _end_failed(self, attempt: _Attempt, code: str) -> None:
        await self._transfers.mark_failed(attempt.transfer_id, attempt.number, code)
        await self._session.commit()

    async def _leave(self, outcome: ReleaseOutcome) -> ReleaseOutcome:
        """Ends the transaction (and its locks) with nothing written."""
        await self._session.rollback()
        return outcome


def _fitting(made: TransferFacts, attempt: _Attempt) -> TransferFacts:
    """The transfer if it is the one the row describes; else nothing is stored for it."""
    if (
        made.amount_cents != attempt.amount_cents
        or made.currency != attempt.currency
        or made.destination != attempt.destination
        or made.job_id != str(attempt.job_id)
        or made.reversed
    ):
        raise _NeedsReviewError("transfer_mismatch")
    return made
