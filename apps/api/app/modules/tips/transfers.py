"""The transfer of a tip to its pro (#273 PR A2; ADR 0005): the whole tip, 100 %. The card fee
is the platform's (Jack absorbs it): nothing is deducted.

A tip is a charge of its own on the platform account (tips/service.py), so its transfer is its
own too: never a second `transfers` row (one per job, payments/transfers.py), never the job's
transfer, refund or dispute paths. Three callers, one path, as for the job: the task queued
after the tip succeeds (tips/webhooks.py), and the sweep (transfer_tasks.py) for whatever that
left behind. Any number of them, in any order, make one transfer.

release(tip_id), in four steps:

1. Under the job's row lock (the one every status change, a dispute and a refund take), then
   the tip's:
   - the tip succeeded, and no attempt holds its transfer already (created or reversed: done;
     an attempt stamped less than TRANSFER_STUCK_PENDING_MINUTES ago with no outcome is another
     worker's);
   - staff's, never tried again by itself (held with a code, an ERROR): a tip flagged because
     an earlier attempt took money too (late_success_at, #510 round 1); a job never confirmed;
     a job with a dispute, open or resolved, or with a refund of any kind that may have given
     money back (a refunded or disputed job never sends its tip by itself);
   - the pro: staff approve them now (#41) and they can be paid out (a Stripe account,
     payouts enabled); else held with `pro_not_approved` or `payouts_not_enabled`, no Stripe
     call, and the sweep takes the tip again once they can.
   Then the attempt (its number and start time, and the key) is stamped and COMMITTED: no
   transaction or lock is held across a Stripe call.
2. Stripe, with no transaction open:
   - the tip's PaymentIntent and charge are read from Stripe (StripePayments.tip_charge): the
     intent must be this tip's current attempt (kind, tip, job, attempt, customer, currency
     and amount, tips/intents.mismatches) and succeeded, and its charge must exist and be
     neither refunded (any amount) nor disputed. Anything else creates nothing and is staff's;
   - a retry (any attempt after the first) lists the request's transfer group and looks for a
     transfer whose metadata names this tip (kind "tip", its tip_id), before the charge's
     gates: exactly one that fits (amount, currency, destination, no job_id, not reversed) is
     adopted, so a lost answer never leads to a second create and is never left unrecorded.
     Adopted while the charge would stop a create (refunded or disputed since, or no longer
     matching): stored anyway, since Stripe made it, with an ERROR for staff. More than one
     live match, one that does not fit, only reversed ones, or a listing with further pages:
     nothing is created (staff);
   - the initiation boundary: under the job's lock again, the dispute and refund checks run
     again, and the attempt must still be the row's one under way; then committed;
   - the create: the tip's amount exactly, its currency, to the pro's account, in the request's
     transfer group, from the tip's charge (source_transaction: the pro's money follows the tip
     charge's settlement), metadata kind "tip" and tip_id (no job_id: the job's transfer never
     adopts it, payments/transfers.py skips kind "tip" too), under the key `tip_transfer:<tip
     id>`, the same for every attempt.
3. Under the same locks again: the transfer's id is stored (created). A dispute or refund
   found now (committed while the create answered) cannot stop a transfer Stripe made: an
   ERROR for staff, never a reversal here. The job's status never changes.
4. Once committed, the transfer is read again by its id: a reversal found is recorded
   (record_tip_transfer_reversal, the webhook's own path). The need for this read is durable,
   as for the job (#416 r2): only a read that succeeded stamps transfer_reversal_checked_at; a
   failed one leaves the tip for the recovery cron (check_reversal), which never creates.

A Stripe error on a read, or an answer the create does not give (a network error, a 409, a
429, a 5xx, any other refusal), leaves the tip failed with the code for the next try: the
retry looks the transfer up before creating, so an uncertain create never leads to a second.
Only a create refused for good (TIP_TRANSFER_REFUSED_CODES, an explicit list: Stripe evaluated
the create and made nothing under the key) is held for staff instead (#450 round 4's rule).

Logs carry ids only (the tip, the job, the request, the pro's profile, Stripe's request id and
error code): never an amount, an account id, a charge id, a PaymentIntent id or a transfer id.
"""

import logging
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Final

from sqlalchemy import Subquery, select, union
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.stripe_errors import (
    StripeCallError,
    StripeRejectedError,
    StripeUnavailableError,
)
from app.integrations.stripe_payments import TIP_INTENT_KIND, StripePayments, TipChargeFacts
from app.integrations.stripe_transfers import StripeTransfers, TransferFacts
from app.modules.disputes.service import disputed_jobs, has_dispute
from app.modules.jobs.service import JobTipFacts, JobTipReader
from app.modules.payments.refund_reader import job_has_returned_money, returned_money_jobs
from app.modules.payments.service import transfer_group
from app.modules.payments.transfers import ReversalCheckOutcome, TransferConfig
from app.modules.pros.service import ProService
from app.modules.tips.intents import mismatches
from app.modules.tips.models import TIP_TRANSFER_MADE, Tip, TipStatus, TipTransferStatus
from app.modules.tips.repository import TipRepository, TipTransferRepository
from app.modules.tips.transfer_webhooks import record_tip_transfer_reversal
from app.modules.users.service import UserService

logger = logging.getLogger(__name__)

# transfer_last_error_code values of ours, beside Stripe's own codes (64 characters at most).
# Waiting for the pro: the sweep tries the tip again once they can be paid out.
PAYOUTS_NOT_ENABLED: Final = "payouts_not_enabled"
PRO_NOT_APPROVED: Final = "pro_not_approved"
WAITING_CODES: Final = frozenset({PAYOUTS_NOT_ENABLED, PRO_NOT_APPROVED})
_WAIT_LOGS: Final = {
    PAYOUTS_NOT_ENABLED: "tip_transfer_payouts_not_enabled",
    PRO_NOT_APPROVED: "tip_transfer_pro_not_approved",
}
# Staff's: never tried again by itself.
LATE_SUCCESS: Final = "tip_late_success"
JOB_NOT_CONFIRMED: Final = "job_not_confirmed"
JOB_REFUNDED_OR_DISPUTED: Final = "job_refunded_or_disputed"
TIP_CHARGE_NOT_PAYABLE: Final = "tip_charge_not_payable"
TIP_TRANSFER_NEEDS_REVIEW: Final = "tip_transfer_needs_review"
TIP_TRANSFER_REFUSED: Final = "tip_transfer_refused"
ERROR_CODE_LENGTH: Final = 64

# Stripe's error codes that mean the transfer CREATE was evaluated and refused: no create under
# the key made a transfer, and none will while the account stays as it is. Any other answer, a
# code outside this list or none, says nothing about an earlier create (it fails closed: the
# tip is failed and tried again, and the retry looks the transfer up first). Codes of
# stripe-python 16.1.0 for API version 2026-10-28.endive, each in https://docs.stripe.com/
# error-codes.
TIP_TRANSFER_REFUSED_CODES: Final = frozenset(
    {
        # "Your destination account needs to have at least one of the following capabilities
        # enabled: transfers, crypto_transfers, legacy_payments."
        "insufficient_capabilities_for_transfer",
        # "The requested transfer cannot be created."
        "transfers_not_allowed",
    }
)


def tip_transfer_idempotency_key(tip_id: uuid.UUID) -> str:
    """The same key for every attempt to create this tip's transfer (AGENTS.md "Money")."""
    return f"tip_transfer:{tip_id}"


def blocked_jobs() -> Subquery:
    """The job (`job_id`) of every job whose tip is never sent by itself: a dispute, open or
    resolved, or a refund that may have given money back. For the sweep's query."""
    disputes = disputed_jobs()
    return union(select(disputes.c.job_id), returned_money_jobs()).subquery()


class TipTransferOutcome(StrEnum):
    """What one release call did."""

    # The transfer was made (created now, or found in Stripe and adopted).
    CREATED = "created"
    # The tip's transfer was made before this call.
    ALREADY_CREATED = "already_created"
    # The tip has not succeeded (or does not exist): nothing to send.
    NOT_PAYABLE = "not_payable"
    # The pro cannot be paid out now: tried again once they can.
    HELD = "held"
    # Another worker's attempt is under way.
    IN_FLIGHT = "in_flight"
    # Stripe could not be reached, or did not answer for good: tried again later.
    FAILED = "failed"
    # Staff must look (an ERROR says why): never tried again by itself.
    NEEDS_REVIEW = "needs_review"
    # No Stripe secret key (allowed outside staging and production).
    NOT_CONFIGURED = "not_configured"


@dataclass(frozen=True)
class _Attempt:
    """One Stripe attempt as its steps need it, copied before the transaction that stamped it
    ends."""

    tip_id: uuid.UUID
    job_id: uuid.UUID
    request_id: uuid.UUID
    pro_id: uuid.UUID
    amount_cents: int
    currency: str
    destination: str
    payment_intent_id: str
    stripe_customer_id: str | None
    # The tip's PaymentIntent attempt (its key tip:<id>:<attempt>), and this transfer attempt.
    tip_attempt: int
    number: int

    @property
    def ids(self) -> dict[str, str | int]:
        """For logs: ids and the attempt's number only."""
        return {
            "tip_id": str(self.tip_id),
            "job_id": str(self.job_id),
            "request_id": str(self.request_id),
            "pro_id": str(self.pro_id),
            "attempt": self.number,
        }


class _ReviewError(Exception):
    """Nothing is created: staff must look. `reason` is a fixed word for the log, `code` the
    one stored on the tip."""

    def __init__(self, reason: str, code: str = TIP_TRANSFER_NEEDS_REVIEW) -> None:
        super().__init__(reason)
        self.reason = reason
        self.code = code


class _CreateRefusedError(Exception):
    """Stripe's 4xx answer to the create itself (never to a read or the lookup)."""

    def __init__(self, error: StripeRejectedError) -> None:
        super().__init__(error.code)
        self.error = error

    @property
    def definitive(self) -> bool:
        return self.error.code in TIP_TRANSFER_REFUSED_CODES


@dataclass(frozen=True)
class _Made:
    facts: TransferFacts
    adopted: bool
    # Why Stripe's read of the tip's charge would have stopped a create (an adopted transfer
    # only): it is stored anyway, since Stripe made it, and flagged for staff.
    charge_problem: str | None = None


def _utc_now() -> datetime:
    return datetime.now(UTC)


class TipTransferService:
    def __init__(
        self,
        session: AsyncSession,
        payments: StripePayments | None,
        transfers: StripeTransfers | None,
        config: TransferConfig,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        self._session = session
        self._payments = payments
        self._transfers_api = transfers
        self._config = config
        self._clock = clock
        self._tips = TipRepository(session)
        self._rows = TipTransferRepository(session)
        self._jobs = JobTipReader(session)
        self._pros = ProService(session)
        self._users = UserService(session)

    async def due(self, limit: int) -> list[uuid.UUID]:
        """Up to `limit` ids of the tips the sweep may try now (TipTransferRepository.due).
        Unlocked; ends its transaction."""
        ids = await self._rows.due(
            self._pros.payable(), blocked_jobs(), WAITING_CODES, self._retry_before(), limit
        )
        await self._session.rollback()
        return ids

    async def unchecked_for_reversal(self, limit: int) -> list[uuid.UUID]:
        """Up to `limit` ids of the created tip transfers whose read after the create is still
        to succeed. Unlocked; ends its transaction."""
        ids = await self._rows.unchecked_for_reversal(self._retry_before(), limit)
        await self._session.rollback()
        return ids

    async def check_reversal(self, tip_id: uuid.UUID) -> ReversalCheckOutcome:
        """The recovery read of step 4: claims the check, reads the stored transfer by id,
        records a reversal it finds. Never creates; a Stripe failure is an outcome."""
        if self._transfers_api is None:
            logger.warning("tip_transfer_stripe_not_configured", extra={"tip_id": str(tip_id)})
            return ReversalCheckOutcome.NOT_CONFIGURED
        stripe_transfer_id = await self._rows.claim_reversal_check(
            tip_id, self._clock(), self._retry_before()
        )
        if stripe_transfer_id is None:
            await self._session.rollback()
            return ReversalCheckOutcome.SKIPPED
        await self._session.commit()  # the claim, before the read: a second worker skips it
        return await self._read_reversal(
            self._transfers_api, tip_id, stripe_transfer_id, {"tip_id": str(tip_id)}
        )

    async def release(self, tip_id: uuid.UUID) -> TipTransferOutcome:
        """Makes the tip's transfer to its pro, once (see the module doc). Ends every
        transaction it opens; a Stripe failure is an outcome, never an exception."""
        if self._payments is None or self._transfers_api is None:
            logger.warning("tip_transfer_stripe_not_configured", extra={"tip_id": str(tip_id)})
            return TipTransferOutcome.NOT_CONFIGURED
        attempt = await self._prepare(tip_id)
        if isinstance(attempt, TipTransferOutcome):
            return attempt
        try:
            made = await self._transfer(self._payments, self._transfers_api, attempt)
            if isinstance(made, TipTransferOutcome):
                return made  # stopped at the initiation boundary: no create
        except _ReviewError as review:
            await self._end(attempt, TipTransferStatus.HELD, review.code)
            logger.error(
                "tip_transfer_needs_review", extra={**attempt.ids, "reason": review.reason}
            )
            return TipTransferOutcome.NEEDS_REVIEW
        except _CreateRefusedError as refused:
            if refused.definitive:
                await self._end(attempt, TipTransferStatus.HELD, TIP_TRANSFER_REFUSED)
                logger.error(
                    "tip_transfer_refused",
                    extra={**attempt.ids, **_stripe_ids(refused.error)},
                )
                return TipTransferOutcome.NEEDS_REVIEW
            return await self._failed(attempt, refused.error)
        except StripeCallError as error:
            return await self._failed(attempt, error)
        return await self._settle(self._transfers_api, attempt, made)

    def _retry_before(self) -> datetime:
        return self._clock() - self._config.stuck_after

    async def _prepare(self, tip_id: uuid.UUID) -> _Attempt | TipTransferOutcome:
        """Step 1: the checks under the job's lock then the tip's, and the attempt stamped and
        committed. An outcome when no Stripe call is to be made."""
        job_id = await self._rows.job_of(tip_id)
        job = None if job_id is None else await self._jobs.locked(job_id)
        tip = None if job is None else await self._tips.get_for_update(tip_id)
        if (
            job is None
            or tip is None
            or tip.status is not TipStatus.SUCCEEDED
            or tip.stripe_payment_intent_id is None
        ):
            return await self._leave(TipTransferOutcome.NOT_PAYABLE)
        ids = {"tip_id": str(tip.id), "job_id": str(job.job_id), "pro_id": str(tip.pro_id)}
        if tip.transfer_status in TIP_TRANSFER_MADE:
            return await self._leave(TipTransferOutcome.ALREADY_CREATED)
        if self._in_flight(tip):
            return await self._leave(TipTransferOutcome.IN_FLIGHT)
        staff = await self._staff_reason(tip, job)
        if staff is not None:
            await self._rows.hold(tip.id, staff)
            await self._session.commit()
            logger.error("tip_transfer_needs_review", extra={**ids, "reason": staff})
            return TipTransferOutcome.NEEDS_REVIEW
        account = await self._pros.payout_account_of_profile(tip.pro_id)
        if account is not None and not account.approved:
            # Staff rejected the pro, or never approved them: Stripe may still have their
            # payouts enabled, so this is the check that keeps the tip here.
            return await self._wait(tip.id, PRO_NOT_APPROVED, ids)
        destination = None if account is None else account.stripe_account_id
        if account is None or destination is None or not account.payouts_enabled:
            return await self._wait(tip.id, PAYOUTS_NOT_ENABLED, ids)
        customer = await self._users.stripe_customer_id(tip.customer_id)
        number = await self._rows.start_attempt(
            tip.id, self._clock(), tip_transfer_idempotency_key(tip.id)
        )
        if number is None:  # pragma: no cover - the row is locked since its status was read
            return await self._leave(TipTransferOutcome.ALREADY_CREATED)
        attempt = _Attempt(
            tip_id=tip.id,
            job_id=job.job_id,
            request_id=job.request_id,
            pro_id=tip.pro_id,
            # The tip's own amount, all of it: never a share, never less a fee.
            amount_cents=tip.amount_cents,
            currency=tip.currency,
            destination=destination,
            payment_intent_id=tip.stripe_payment_intent_id,
            stripe_customer_id=customer,
            tip_attempt=tip.attempt,
            number=number,
        )
        await self._session.commit()  # before any Stripe call; the locks end here
        return attempt

    async def _staff_reason(self, tip: Tip, job: JobTipFacts) -> str | None:
        """Why the tip is staff's and never sent by itself; None when it may be sent."""
        if tip.late_success_at is not None:
            return LATE_SUCCESS
        if job.confirmed_at is None or tip.pro_id != job.pro_id or tip.amount_cents <= 0:
            return JOB_NOT_CONFIRMED
        if await self._money_returned(job.job_id):
            return JOB_REFUNDED_OR_DISPUTED
        return None

    async def _money_returned(self, job_id: uuid.UUID) -> bool:
        """A dispute of the job, open or resolved, or a refund of it that may have given money
        back. Read under the job's lock, the one disputes and refunds take."""
        return await has_dispute(self._session, job_id) or await job_has_returned_money(
            self._session, job_id
        )

    def _in_flight(self, tip: Tip) -> bool:
        """An attempt was stamped, has no outcome yet, and is too recent to be lost."""
        return (
            tip.transfer_status is TipTransferStatus.PENDING
            and tip.transfer_last_error_code is None
            and tip.transfer_requested_at is not None
            and self._clock() - tip.transfer_requested_at < self._config.stuck_after
        )

    async def _wait(self, tip_id: uuid.UUID, code: str, ids: dict[str, str]) -> TipTransferOutcome:
        await self._rows.hold(tip_id, code)
        await self._session.commit()
        logger.warning(_WAIT_LOGS[code], extra=ids)
        return TipTransferOutcome.HELD

    async def _transfer(
        self, payments: StripePayments, transfers: StripeTransfers, attempt: _Attempt
    ) -> _Made | TipTransferOutcome:
        """Step 2: Stripe's read of the tip's charge, then the transfer found (a retry) or
        created. A retry looks the transfer up BEFORE the charge's gates: a transfer an
        earlier attempt made is stored whatever the charge shows now (and flagged when the
        charge would stop a create), never left unrecorded. No transaction is open during a
        Stripe call."""
        charge = await payments.tip_charge(attempt.payment_intent_id)
        group = transfer_group(attempt.request_id)
        if attempt.number > 1:
            found = await transfers.list_transfers(group)
            if not found.complete:
                raise _ReviewError("listing_incomplete")
            ours = [
                fact
                for fact in found.transfers
                if fact.kind == TIP_INTENT_KIND and fact.tip_id == str(attempt.tip_id)
            ]
            live = [fact for fact in ours if not fact.reversed]
            if len(live) > 1:
                raise _ReviewError("several_transfers")
            if live:
                problem = _charge_problem(charge, attempt)
                return _Made(_fitting(live[0], attempt), adopted=True, charge_problem=problem)
            if ours:
                # The tip's only transfers were reversed: sending it again is staff's call.
                raise _ReviewError("transfer_reversed")
        source = _payable_charge(charge, attempt)
        stopped = await self._cross_boundary(attempt)
        if stopped is not None:
            return stopped
        try:
            created = await transfers.create_transfer(
                # From the row committed in step 1, never from a request or a rate.
                amount_cents=attempt.amount_cents,
                currency=attempt.currency,
                destination=attempt.destination,
                transfer_group=group,
                source_transaction=source,
                metadata={"kind": TIP_INTENT_KIND, "tip_id": str(attempt.tip_id)},
                idempotency_key=tip_transfer_idempotency_key(attempt.tip_id),
            )
        except StripeRejectedError as error:
            raise _CreateRefusedError(error) from None
        return _Made(_fitting(created, attempt), adopted=False)

    async def _cross_boundary(self, attempt: _Attempt) -> TipTransferOutcome | None:
        """The initiation boundary, in a short transaction right before the create: under the
        job's lock, a dispute or refund committed since step 1 stops the create (staff's), and
        an attempt a later one took over stops too. None when the create may go on."""
        await self._jobs.locked(attempt.job_id)
        if not await self._rows.is_attempt(attempt.tip_id, attempt.number):
            await self._session.rollback()
            logger.warning("tip_transfer_attempt_superseded", extra=attempt.ids)
            return TipTransferOutcome.IN_FLIGHT
        if await self._money_returned(attempt.job_id):
            await self._rows.end_attempt(
                attempt.tip_id, attempt.number, TipTransferStatus.HELD, JOB_REFUNDED_OR_DISPUTED
            )
            await self._session.commit()
            logger.error(
                "tip_transfer_needs_review",
                extra={**attempt.ids, "reason": JOB_REFUNDED_OR_DISPUTED},
            )
            return TipTransferOutcome.NEEDS_REVIEW
        await self._session.commit()
        return None

    async def _settle(
        self, transfers: StripeTransfers, attempt: _Attempt, made: _Made
    ) -> TipTransferOutcome:
        """Step 3, then step 4. A dispute or refund found as the transfer is stored cannot stop
        a transfer Stripe made: an ERROR for staff, in the same transaction."""
        await self._jobs.locked(attempt.job_id)
        stored = await self._rows.mark_created(
            attempt.tip_id, made.facts.transfer_id, self._clock()
        )
        if not stored:
            # Another attempt of this tip stored it first: the same transfer (one key).
            return await self._leave(TipTransferOutcome.ALREADY_CREATED)
        how = "adopted" if made.adopted else "created"
        if await self._money_returned(attempt.job_id):
            logger.error(
                "tip_transfer_needs_reversal",
                extra={**attempt.ids, "stored_under_hold": how, "reason": JOB_REFUNDED_OR_DISPUTED},
            )
        if made.charge_problem is not None:
            # An earlier attempt's create made it before the charge went back (or stopped
            # matching): staff reverse it in Stripe; nothing here undoes a transfer.
            logger.error(
                "tip_transfer_needs_reversal",
                extra={**attempt.ids, "stored_under_hold": how, "reason": made.charge_problem},
            )
        await self._session.commit()
        logger.info(
            "tip_transfer_created",
            extra={
                **attempt.ids,
                "adopted": str(made.adopted).lower(),
                "stripe_request_id": made.facts.request_id,
            },
        )
        await self._read_reversal(transfers, attempt.tip_id, made.facts.transfer_id, attempt.ids)
        return TipTransferOutcome.CREATED

    async def _read_reversal(
        self,
        transfers: StripeTransfers,
        tip_id: uuid.UUID,
        stripe_transfer_id: str,
        ids: Mapping[str, str | int],
    ) -> ReversalCheckOutcome:
        """Step 4: the stored transfer read again by its id, a reversal recorded and the check
        stamped as done in one transaction. A failed read stamps nothing."""
        try:
            current = await transfers.retrieve_transfer(stripe_transfer_id)
        except StripeCallError as error:
            logger.warning(
                "tip_transfer_reversal_check_failed", extra={**ids, **_stripe_ids(error)}
            )
            return ReversalCheckOutcome.FAILED
        if current.reversed:
            await record_tip_transfer_reversal(self._session, stripe_transfer_id, ids)
        await self._rows.mark_reversal_checked(tip_id, stripe_transfer_id, self._clock())
        await self._session.commit()
        return ReversalCheckOutcome.REVERSED if current.reversed else ReversalCheckOutcome.CHECKED

    async def _failed(self, attempt: _Attempt, error: StripeCallError) -> TipTransferOutcome:
        # Its code, or its class: never its text (stripe_errors.py carries none).
        code = (error.code or type(error).__name__)[:ERROR_CODE_LENGTH]
        await self._end(attempt, TipTransferStatus.FAILED, code)
        logger.error(
            "tip_transfer_stripe_unavailable"
            if isinstance(error, StripeUnavailableError)
            else "tip_transfer_stripe_rejected",
            extra={**attempt.ids, **_stripe_ids(error)},
        )
        return TipTransferOutcome.FAILED

    async def _end(self, attempt: _Attempt, status: TipTransferStatus, code: str) -> None:
        await self._rows.end_attempt(attempt.tip_id, attempt.number, status, code)
        await self._session.commit()

    async def _leave(self, outcome: TipTransferOutcome) -> TipTransferOutcome:
        """Ends the transaction (and its locks) with nothing written."""
        await self._session.rollback()
        return outcome


def _payable_charge(charge: TipChargeFacts, attempt: _Attempt) -> str:
    """The charge a transfer may pay from: the tip's current attempt's, succeeded, neither
    refunded nor disputed, as Stripe shows it now. Else nothing is created (staff)."""
    problem = _charge_problem(charge, attempt)
    if problem is not None or charge.charge_id is None:
        raise _ReviewError(problem or "tip_not_charged", TIP_CHARGE_NOT_PAYABLE)
    return charge.charge_id


def _charge_problem(charge: TipChargeFacts, attempt: _Attempt) -> str | None:
    """Why the charge is no charge to pay this tip from (a fixed word), or None."""
    differ = mismatches(
        charge.intent,
        tip_id=attempt.tip_id,
        job_id=attempt.job_id,
        attempt=attempt.tip_attempt,
        amount_cents=attempt.amount_cents,
        currency=attempt.currency,
        stripe_customer_id=attempt.stripe_customer_id,
    )
    if (
        differ
        or charge.intent.attempt != str(attempt.tip_attempt)
        or charge.intent.payment_intent_id != attempt.payment_intent_id
    ):
        return "tip_intent_mismatch"
    if charge.intent.status != "succeeded" or charge.charge_id is None:
        return "tip_not_charged"
    if charge.refunded or charge.disputed:
        return "tip_charge_returned"
    return None


def _fitting(made: TransferFacts, attempt: _Attempt) -> TransferFacts:
    """The transfer if it is the one the tip describes; else nothing is stored for it."""
    if (
        made.amount_cents != attempt.amount_cents
        or made.currency != attempt.currency
        or made.destination != attempt.destination
        or made.kind != TIP_INTENT_KIND
        or made.tip_id != str(attempt.tip_id)
        or made.job_id is not None
        or made.reversed
    ):
        raise _ReviewError("transfer_mismatch")
    return made


def _stripe_ids(error: StripeCallError) -> dict[str, str | None]:
    return {"stripe_request_id": error.request_id, "stripe_code": error.code}
