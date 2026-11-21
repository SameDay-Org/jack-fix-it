"""The transfer to the pro once their job is confirmed (D13.3, #68; ADR 0005): the last step
of the money loop.

The customer's payment stays on the platform balance (service.py). When the job is confirmed,
by the customer (#66) or by the 48 h auto-confirm (#67), TransferService.release moves the pro's
share to their Stripe Express account and the job to paid_out. Three callers, one path: the
worker task queued after each confirmation, and the sweep (transfer_tasks.py) for whatever those
left behind. Any number of them, in any order, make one transfer.

release(job_id), in four steps:

1. Under the job's row lock (the one every status change takes), then the transfer row's:
   - the job is confirmed, or disputed with its dispute resolved by an admin's release, full
     or partial (#76): anything else is left alone (not_confirmed);
   - nothing holds its money back (has_open_hold: an open dispute, #75, or a dispute refund
     Stripe has not finished, #433 round 1: a partial release pays the pro only once the
     customer's part is back, and never while Stripe fails or cancels it);
   - no attempt is under way: a row pending with an attempt stamped less than
     TRANSFER_STUCK_PENDING_MINUTES ago and no outcome is another worker's (in_flight);
   - the job's payment succeeded and froze the same payout as the job did, a positive one;
   - the transfer row exists, or is created now: one per job (unique job_id), with the amount
     copied from the job's frozen pro_payout_cents, never computed from a rate (a released
     dispute's pro_release_cents: the payout in full, or the part the admin released);
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
   request's transfer group and looks for a transfer whose metadata names the job (never a
   tip's, kind "tip", #273 PR A2, in the same group): exactly one
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
   confirmed -> paid_out through JobStateMachine as the system (disputed -> paid_out as the
   admin who resolved the dispute), one job_events row, in one transaction.
4. Once that is committed, the transfer is read from Stripe again by its stored id. A
   transfer reversed between its create and step 3 (its create answer slow to come back) had
   its transfer.reversed event find no row with its id, and that event is processed and gone.
   So a reversal found now is recorded through the webhook's own path (record_reversal); a
   later event finds the stored id itself, and whichever comes second changes nothing. The
   need for this read is durable (#416 r2): step 3 commits the row with
   reversal_check_tried_at stamped and reversal_checked_at NULL, and only a read that
   succeeded stamps reversal_checked_at, in the transaction that records what it found. A read
   that fails, or never ends (a cancelled task, a dead worker), leaves the row for the
   recovery cron (check_reversal, from transfer_tasks.py): every created transfer whose check
   has not succeeded, whatever its job's state, once TRANSFER_STUCK_PENDING_MINUTES have passed
   since the latest try. It reads by the exact stored id and never creates anything.

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

from sqlalchemy import Subquery, select, union
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.stripe_errors import StripeCallError, StripeUnavailableError
from app.integrations.stripe_payments import TIP_INTENT_KIND
from app.integrations.stripe_transfers import StripeTransfers, TransferFacts
from app.modules.disputes.service import (
    ReleasedDispute,
    has_open_dispute,
    open_dispute_jobs,
    released_dispute,
    released_dispute_jobs,
)
from app.modules.jobs.service import AdminDecision, JobPayoutFacts, JobPayouts
from app.modules.payments.models import (
    MADE_STATUSES,
    TRANSFER_ERROR_CODE_LENGTH,
    Transfer,
    TransferStatus,
)
from app.modules.payments.repository import (
    PaymentRepository,
    RefundRepository,
    TransferRepository,
)
from app.modules.payments.service import transfer_group
from app.modules.payments.transfer_webhooks import record_reversal
from app.modules.pros.service import ProService

logger = logging.getLogger(__name__)

# last_error_code values of ours, beside Stripe's own codes.
# A hold (or a move of the job) seen at the initiation boundary stopped the create (#450 round 4).
HELD_BEFORE_CREATE: Final = "held_before_create"
PAYOUTS_NOT_ENABLED: Final = "payouts_not_enabled"
PRO_NOT_APPROVED: Final = "pro_not_approved"
TRANSFER_NEEDS_REVIEW: Final = "transfer_needs_review"


def transfer_idempotency_key(job_id: uuid.UUID) -> str:
    """The same key for every attempt to create this job's transfer (AGENTS.md "Money": every
    transfer carries a deterministic idempotency key)."""
    return f"transfer:{job_id}"


async def has_open_hold(session: AsyncSession, job: JobPayoutFacts) -> bool:
    """Whether something holds the job's money back: an open dispute (#75), or a dispute
    refund Stripe has not finished (#433 round 1: anything but `succeeded`, failed or canceled
    included). Such a job is never released, by any path, and the sweep's query leaves it out
    (_held_jobs).

    A report moves the job completed -> disputed, which release never reads either; the hold
    is what keeps the money back whatever the job's status, until an admin resolves it (#76)
    and Stripe gave the customer's part back.
    """
    return await has_open_dispute(session, job.job_id) or await RefundRepository(
        session
    ).unsettled_of_job(job.job_id)


async def flag_transfer_for_reversal(
    session: AsyncSession, job_id: uuid.UUID, now: datetime
) -> uuid.UUID | None:
    """For a late refund's hold (#450 round 4): flags the job's transfer if it may already be
    issued (made, or its current attempt past the initiation boundary), so a payout the hold
    came too late to stop is never kept silently. Staff reverse it by hand
    (docs/stripe-money.md); nothing reverses it automatically and nothing clears the flag. The
    transfer row's id, or None when no transfer of the job may be issued. The caller holds the
    job's lock (the boundary's), so the boundary is strictly before or after it."""
    return await TransferRepository(session).flag_needs_reversal(job_id, now)


def _held_jobs() -> Subquery:
    """The job (`job_id`) of every job has_open_hold holds, for the sweep's query."""
    open_disputes = open_dispute_jobs()
    return union(
        select(open_disputes.c.job_id), RefundRepository.unsettled_dispute_jobs()
    ).subquery()


class ReversalCheckOutcome(StrEnum):
    """What one recovery read of a stored transfer did (check_reversal)."""

    # Read: not reversed. Stamped as checked.
    CHECKED = "checked"
    # Read: reversed, and recorded now (or already by the event). Stamped as checked.
    REVERSED = "reversed"
    # Nothing to do: checked already, tried too recently, or not a created transfer.
    SKIPPED = "skipped"
    # Stripe refused or could not be reached: tried again later.
    FAILED = "failed"
    # No Stripe secret key.
    NOT_CONFIGURED = "not_configured"


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
    # The admin whose release of the job's dispute this transfer carries out (#76); None for a
    # confirmed job.
    decided_by: uuid.UUID | None = None

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


@dataclass(frozen=True)
class _Made:
    """The job's transfer as Stripe holds it, and whether this attempt found it (a retry's
    lookup) rather than creating it."""

    facts: TransferFacts
    adopted: bool


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
        """Up to `limit` ids of the jobs the sweep may try now (confirmed, or disputed and
        released by an admin), least recently tried first (TransferRepository.due). Unlocked;
        ends its transaction."""
        job_ids = await self._transfers.due(
            self._jobs.awaiting_transfer(released_dispute_jobs()),
            self._pros.payable(),
            _held_jobs(),
            self._clock() - self._config.stuck_after,
            limit,
        )
        await self._session.rollback()
        return job_ids

    async def unchecked_for_reversal(self, limit: int) -> list[uuid.UUID]:
        """Up to `limit` ids of the created transfers whose reversal check is still to
        succeed, least recently tried first (TransferRepository.unchecked_for_reversal).
        Unlocked; ends its transaction."""
        ids = await self._transfers.unchecked_for_reversal(self._retry_before(), limit)
        await self._session.rollback()
        return ids

    async def check_reversal(self, transfer_id: uuid.UUID) -> ReversalCheckOutcome:
        """The recovery read of step 4 (see the module doc): claims the row's check, reads
        its stored transfer from Stripe by id, records a reversal it finds. Never creates.
        Ends every transaction it opens; a Stripe failure is an outcome."""
        if self._stripe is None:
            logger.warning(
                "transfer_stripe_not_configured", extra={"transfer_id": str(transfer_id)}
            )
            return ReversalCheckOutcome.NOT_CONFIGURED
        stripe_transfer_id = await self._transfers.claim_reversal_check(
            transfer_id, self._clock(), self._retry_before()
        )
        if stripe_transfer_id is None:
            await self._session.rollback()
            return ReversalCheckOutcome.SKIPPED
        # The claim is stored before the read: a second worker leaves the row alone.
        await self._session.commit()
        return await self._read_reversal(
            self._stripe, transfer_id, stripe_transfer_id, {"transfer_id": str(transfer_id)}
        )

    def _retry_before(self) -> datetime:
        return self._clock() - self._config.stuck_after

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
            if isinstance(made, ReleaseOutcome):
                return made  # stopped at the initiation boundary: no create
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
        if job is None or not (job.confirmed or job.disputed):
            return await self._leave(ReleaseOutcome.NOT_CONFIRMED)
        ids = {"job_id": str(job.job_id), "pro_id": str(job.pro_id)}
        if await has_open_hold(self._session, job):
            logger.info("transfer_held", extra=ids)
            return await self._leave(ReleaseOutcome.HELD)
        # A disputed job is paid only as an admin released it (#76): refunded, it never is.
        decision = await released_dispute(self._session, job.job_id) if job.disputed else None
        if job.disputed and decision is None:
            return await self._leave(ReleaseOutcome.NOT_CONFIRMED)
        transfer = await self._transfers.get_of_job_for_update(job.job_id)
        if transfer is not None and transfer.status in MADE_STATUSES:
            return await self._already_made(job, transfer, decision)
        if transfer is not None and self._in_flight(transfer):
            return await self._leave(ReleaseOutcome.IN_FLIGHT)
        payment = await self._payments.succeeded_of_quote(job.quote_id)
        if payment is None or payment.stripe_payment_intent_id is None:
            logger.error("transfer_payment_missing", extra=ids)
            return await self._leave(ReleaseOutcome.NEEDS_REVIEW)
        # The job's frozen payout, never a rate: it must be what the payment froze too, and
        # what an earlier release of this job stored. A released dispute pays the part of it
        # the admin released (all of it for a full release), never more.
        amount_cents = job.pro_payout_cents if decision is None else decision.pro_release_cents
        if (
            amount_cents <= 0
            or job.pro_payout_cents != payment.pro_payout_cents
            or amount_cents > job.pro_payout_cents
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
            decided_by=None if decision is None else decision.resolved_by,
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

    async def _already_made(
        self, job: JobPayoutFacts, transfer: Transfer, decision: ReleasedDispute | None
    ) -> ReleaseOutcome:
        """The row holds a transfer Stripe made, and the job is still confirmed (or disputed
        and released): a created one only misses the job's move (its transaction is the one
        that stores the transfer, so this is a row staff repaired by hand after a review; the
        sweep reads these); a reversed one is staff's."""
        ids = {"job_id": str(job.job_id), "transfer_id": str(transfer.id)}
        if transfer.status is not TransferStatus.CREATED:
            logger.error("transfer_reversed_job_confirmed", extra=ids)
            return await self._leave(ReleaseOutcome.NEEDS_REVIEW)
        await self._paid_out(job, None if decision is None else decision.resolved_by)
        await self._session.commit()
        logger.warning("transfer_job_paid_out_late", extra=ids)
        return ReleaseOutcome.ALREADY_CREATED

    async def _transfer(self, stripe: StripeTransfers, attempt: _Attempt) -> _Made | ReleaseOutcome:
        """Step 2: the job's transfer in Stripe, found (a retry) or created. No transaction
        is open during a Stripe call. Before the create, the initiation boundary
        (_cross_boundary): an outcome when it stops the create."""
        group = transfer_group(attempt.request_id)
        if attempt.number > 1:
            found = await stripe.list_transfers(group)
            if not found.complete:
                raise _NeedsReviewError("listing_incomplete")
            # A tip's transfer in the same group (#273 PR A2) is never the job's, whatever its
            # metadata says of a job.
            ours = [
                fact
                for fact in found.transfers
                if fact.job_id == str(attempt.job_id) and fact.kind != TIP_INTENT_KIND
            ]
            live = [fact for fact in ours if not fact.reversed]
            if len(live) > 1:
                raise _NeedsReviewError("several_transfers")
            if live:
                return _Made(_fitting(live[0], attempt), adopted=True)
            if ours:
                # The job's only transfers were reversed: paying again is staff's call.
                raise _NeedsReviewError("transfer_reversed")
        charge_id = await stripe.charge_of_payment_intent(attempt.payment_intent_id)
        stopped = await self._cross_boundary(attempt)
        if stopped is not None:
            return stopped
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
        return _Made(_fitting(created, attempt), adopted=False)

    async def _cross_boundary(self, attempt: _Attempt) -> ReleaseOutcome | None:
        """The transfer's initiation boundary (#450 round 4), in a short transaction right
        before the create: under the job's lock (the one a late refund's hold takes too,
        disputes.refund_webhooks), the hold is checked again and the attempt stamped
        create_started_at, then committed. A hold committed before it stops the create: the row
        stays pending with `held_before_create` (no failure, and the next attempt still looks
        the transfer up before creating) and the outcome is HELD. A hold committed after it
        cannot stop the create any more: the late refund then finds create_started_at and flags
        the transfer for staff (needs_reversal_at). None when the create may go on."""
        job = await self._jobs.locked(attempt.job_id)
        if job is None or not (job.confirmed or job.disputed):
            await self._transfers.hold_back(attempt.transfer_id, HELD_BEFORE_CREATE)
            await self._session.commit()
            logger.warning("transfer_job_moved_before_create", extra=attempt.ids)
            return ReleaseOutcome.NOT_CONFIRMED
        if await has_open_hold(self._session, job):
            await self._transfers.hold_back(attempt.transfer_id, HELD_BEFORE_CREATE)
            await self._session.commit()
            logger.info("transfer_held_before_create", extra=attempt.ids)
            return ReleaseOutcome.HELD
        if not await self._transfers.mark_create_started(
            attempt.transfer_id, attempt.number, self._clock()
        ):
            # A later attempt took the row over (this one outlived the stuck window).
            await self._session.rollback()
            logger.warning("transfer_attempt_superseded", extra=attempt.ids)
            return ReleaseOutcome.IN_FLIGHT
        await self._session.commit()
        return None

    async def _settle(
        self, stripe: StripeTransfers, attempt: _Attempt, made: _Made
    ) -> ReleaseOutcome:
        """Step 3: the transfer's id stored and the job paid_out, in one transaction; then
        step 4. A hold present as it is stored (#450 round 5: a late refund committed while a
        retry looked the transfer up, or while a first create was still answering) cannot stop
        a transfer Stripe already made: it is flagged for staff in the same transaction
        (needs_reversal_at), whether this attempt adopted it or created it."""
        job = await self._jobs.locked(attempt.job_id)
        stored = await self._transfers.mark_created(
            attempt.transfer_id, made.facts.transfer_id, self._clock()
        )
        if not stored:
            # Another attempt of this job stored it first: the same transfer (one key).
            return await self._leave(ReleaseOutcome.ALREADY_CREATED)
        held = job is not None and await has_open_hold(self._session, job)
        if held and made.adopted:
            await self._flag_stored_under_hold(attempt, "adopted")
        if held and not made.adopted:
            await self._flag_stored_under_hold(attempt, "created")
        if job is not None and (job.confirmed or job.disputed):
            await self._paid_out(job, attempt.decided_by)
        else:  # pragma: no cover - only release moves a confirmed job, under this lock
            logger.error("transfer_created_job_not_confirmed", extra=attempt.ids)
        await self._session.commit()
        logger.info(
            "transfer_created", extra={**attempt.ids, "stripe_request_id": made.facts.request_id}
        )
        await self._read_reversal(stripe, attempt.transfer_id, made.facts.transfer_id, attempt.ids)
        return ReleaseOutcome.CREATED

    async def _flag_stored_under_hold(self, attempt: _Attempt, how: str) -> None:
        """The transfer just stored, under a hold: flagged for staff, never reversed here. `how`:
        adopted (a retry's lookup found it) or created (this attempt's create answered)."""
        await self._transfers.flag_needs_reversal(attempt.job_id, self._clock())
        logger.error("transfer_needs_reversal", extra={**attempt.ids, "stored_under_hold": how})

    async def _read_reversal(
        self,
        stripe: StripeTransfers,
        transfer_id: uuid.UUID,
        stripe_transfer_id: str,
        ids: dict[str, str | int],
    ) -> ReversalCheckOutcome:
        """Step 4: the stored transfer read again by its id, a reversal recorded and the
        check stamped as done in one transaction (see the module doc). No transaction is open
        during the read; a failed read stamps nothing."""
        try:
            current = await stripe.retrieve_transfer(stripe_transfer_id)
        except StripeCallError as error:
            # For staff, and for the recovery cron: the row still says its check is needed.
            logger.warning(
                "transfer_reversal_check_failed",
                extra={**ids, "stripe_request_id": error.request_id, "stripe_code": error.code},
            )
            return ReversalCheckOutcome.FAILED
        if current.reversed:
            await record_reversal(self._session, stripe_transfer_id, ids)
        await self._transfers.mark_reversal_checked(transfer_id, stripe_transfer_id, self._clock())
        await self._session.commit()
        return ReversalCheckOutcome.REVERSED if current.reversed else ReversalCheckOutcome.CHECKED

    async def _paid_out(self, job: JobPayoutFacts, decided_by: uuid.UUID | None) -> None:
        """The job's move to paid_out: as the system for a confirmed job, as the admin whose
        release it carries out for a disputed one (the machine refuses anything else)."""
        if job.disputed and decided_by is not None:
            await self._jobs.paid_out(job.job_id, AdminDecision(decided_by))
        else:
            await self._jobs.paid_out(job.job_id)

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
