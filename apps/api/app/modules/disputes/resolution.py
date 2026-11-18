"""An admin resolves a dispute (#76; D15.3, D15.4): the pro paid, the customer refunded, or a
split of the two.

- release: the pro's frozen payout in full, no refund. The dispute is resolved at once; the
  job's transfer follows (payments.transfers.TransferService.release: queued after the commit,
  and the transfer sweep for whatever that leaves), which moves the job disputed -> paid_out as
  the admin who decided.
- refund: the customer's total (tax included) back to their payment method, no transfer. The
  job moves disputed -> refunded, the admin as actor.
- partial: the admin names pro_release_cents, strictly between 0 and the payout. The customer
  gets back app.money.partial_refund_cents (the share of their total the pro is not paid,
  rounded half up); the platform keeps the rest (its fee and the tax in proportion). The
  refund first, then the transfer as for a release.

Money: every amount comes from the job's frozen payout and its succeeded payment; the client
names only pro_release_cents, checked against them. The platform absorbs Stripe's fees.

A refund, in three steps (no transaction or lock is held across a Stripe call):
1. Under the job's row lock (the one every status change takes), then the dispute's: the
   checks, the refund row (pending, key `dispute:<id>:refund`, unique: one refund per
   dispute) and its attempt stamped, COMMITTED before any Stripe call.
2. Stripe (payments.refunds.make_refund): an attempt after the first looks for the refund of
   a lost answer before it creates one; the create carries the key.
3. Under the same locks, one transaction: the refund stored (created), the dispute resolved,
   the job refunded (full refund), the audit row.
A Stripe error stores the row failed with Stripe's code (never its text) and answers 502/503:
the dispute stays open and the job disputed; the same decision tries again.

Once: a resolved dispute answers the same decision (and split) with where it stands, queueing
its transfer again (the sweep would too) and pushing nothing; another decision is 409
dispute_already_resolved. While the dispute is open with a refund row, only the same amount is
tried again (409 refund_already_attempted: Stripe may hold it), and not while an attempt is
under way (409 resolution_in_progress, for REFUND_STUCK_PENDING_MINUTES). Two admins at once:
the job's lock orders them, and the second reads what the first committed.

Audit: one row per resolution through AuditService.record (an active admin: money), in the
transaction that resolves: the decision, the amounts, the refund's ids; the note is its reason.
After the commit each side is pushed once (one kind per decision), never with the note.
Logs carry ids and the decision only: no amount, no note, no Stripe object id.
"""

import logging
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final, Protocol

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import ForbiddenError, NotFoundError
from app.integrations.stripe_errors import StripeCallError, StripeUnavailableError
from app.integrations.stripe_refunds import RefundFacts, StripeRefunds
from app.modules.audit.service import AuditService
from app.modules.audit.types import (
    AuditAction,
    AuditEntity,
    AuditEntityType,
    Operator,
    OperatorNotAdminError,
)
from app.modules.disputes.errors import (
    DisputeAlreadyResolvedError,
    DisputeNeedsReviewError,
    InvalidSplitError,
    RefundAlreadyAttemptedError,
    ResolutionInProgressError,
)
from app.modules.disputes.models import Dispute, DisputeResolution, DisputeStatus
from app.modules.disputes.repository import DisputeRepository
from app.modules.disputes.staff_schemas import (
    DisputeResolutionOut,
    DisputeResolveIn,
    RefundOut,
    ResolutionDecision,
)
from app.modules.jobs.service import JobDisputeFacts, JobDisputes, JobStatus
from app.modules.notifications.events import (
    push_dispute_closed,
    push_dispute_partly_refunded,
    push_dispute_payout_partly_released,
    push_dispute_payout_refunded,
    push_dispute_payout_released,
    push_dispute_refunded,
)
from app.modules.payments.errors import PaymentsNotConfiguredError
from app.modules.payments.models import REFUND_ERROR_CODE_LENGTH, Refund, RefundStatus
from app.modules.payments.refunds import (
    REFUND_NEEDS_REVIEW,
    RefundAttempt,
    RefundNeedsReviewError,
    dispute_refund_key,
    make_refund,
)
from app.modules.payments.repository import PaymentRepository, RefundRepository, TransferRepository
from app.modules.payments.transfer_queue import enqueue_transfer_release
from app.modules.payouts.errors import PaymentsProviderError, PaymentsUnavailableError
from app.modules.pros.service import ProService
from app.modules.requests.service import CustomerRequestReader
from app.modules.users.types import UserAccount
from app.money import partial_refund_cents
from app.queue import JobQueue

logger = logging.getLogger(__name__)

_RESOLUTION: Final[Mapping[ResolutionDecision, DisputeResolution]] = {
    ResolutionDecision.RELEASE: DisputeResolution.RELEASED,
    ResolutionDecision.PARTIAL: DisputeResolution.PARTIAL_RELEASE,
    ResolutionDecision.REFUND: DisputeResolution.REFUNDED,
}


class _CustomerPush(Protocol):
    def __call__(
        self,
        queue: JobQueue,
        *,
        customer_id: uuid.UUID,
        job_id: uuid.UUID,
        request_id: uuid.UUID,
        public_code: str,
        timeout_seconds: float,
    ) -> Awaitable[None]: ...


class _ProPush(Protocol):
    def __call__(
        self,
        queue: JobQueue,
        *,
        pro_user_id: uuid.UUID,
        job_id: uuid.UUID,
        public_code: str,
        timeout_seconds: float,
    ) -> Awaitable[None]: ...


# Each decision's push to the customer and to the pro.
_PUSHES: Final[Mapping[DisputeResolution, tuple[_CustomerPush, _ProPush]]] = {
    DisputeResolution.RELEASED: (push_dispute_closed, push_dispute_payout_released),
    DisputeResolution.PARTIAL_RELEASE: (
        push_dispute_partly_refunded,
        push_dispute_payout_partly_released,
    ),
    DisputeResolution.REFUNDED: (push_dispute_refunded, push_dispute_payout_refunded),
}


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class ResolutionConfig:
    # How long a refund attempt with no outcome is taken to be under way.
    stuck_after: timedelta
    enqueue_timeout_seconds: float

    @classmethod
    def from_settings(cls, settings: Settings) -> "ResolutionConfig":
        return cls(
            stuck_after=timedelta(minutes=settings.refund_stuck_pending_minutes),
            enqueue_timeout_seconds=settings.job_enqueue_timeout_seconds,
        )


@dataclass(frozen=True)
class _Plan:
    """What a decision moves, in cents: computed here, never taken from the client."""

    resolution: DisputeResolution
    pro_release_cents: int
    customer_refund_cents: int


@dataclass(frozen=True)
class _Locked:
    """The dispute and its job under their locks, the job's payment and the decision's plan."""

    dispute: Dispute
    job: JobDisputeFacts
    payment_id: uuid.UUID
    payment_intent_id: str
    currency: str
    plan: _Plan

    @property
    def ids(self) -> dict[str, str]:
        return {"dispute_id": str(self.dispute.id), "job_id": str(self.job.job_id)}


def _plan(data: DisputeResolveIn, pro_payout_cents: int, customer_total_cents: int) -> _Plan:
    resolution = _RESOLUTION[data.decision]
    if data.decision is ResolutionDecision.RELEASE:
        return _Plan(resolution, pro_payout_cents, 0)
    if data.decision is ResolutionDecision.REFUND:
        return _Plan(resolution, 0, customer_total_cents)
    release = data.pro_release_cents
    if release is None or not 0 < release < pro_payout_cents:
        raise InvalidSplitError
    return _Plan(
        resolution, release, partial_refund_cents(customer_total_cents, pro_payout_cents, release)
    )


def _same(dispute: Dispute, plan: _Plan) -> bool:
    """Whether the dispute was resolved with this very decision and split."""
    return (
        dispute.resolution is plan.resolution
        and dispute.pro_release_cents == plan.pro_release_cents
        and dispute.customer_refund_cents == plan.customer_refund_cents
    )


class DisputeResolver:
    def __init__(
        self,
        session: AsyncSession,
        stripe: StripeRefunds | None,
        config: ResolutionConfig,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._session = session
        self._stripe = stripe
        self._config = config
        self._clock = clock
        self._disputes = DisputeRepository(session)
        self._refunds = RefundRepository(session)
        self._payments = PaymentRepository(session)
        self._transfers = TransferRepository(session)
        self._jobs = JobDisputes(session, ProService(session))
        self._requests = CustomerRequestReader(session)
        self._audit = AuditService(session)

    async def resolve(
        self, admin: UserAccount, dispute_id: uuid.UUID, data: DisputeResolveIn, queue: JobQueue
    ) -> DisputeResolutionOut:
        """Applies the admin's decision once (see the module doc). Ends every transaction it
        opens."""
        locked = await self._lock(dispute_id, data)
        if locked.dispute.status is DisputeStatus.RESOLVED:
            return await self._replay(locked, queue)
        if locked.plan.customer_refund_cents == 0:
            return await self._release(admin, locked, data.note, queue)
        return await self._refund(admin, locked, data, queue)

    async def _lock(self, dispute_id: uuid.UUID, data: DisputeResolveIn) -> _Locked:
        """The job's row lock, then the dispute's, each read as last committed; the job's
        payment, checked against the job; the decision's plan. Raises after a rollback."""
        found = await self._disputes.get(dispute_id)
        if found is None:
            raise NotFoundError
        job = await self._jobs.locked(found.job_id)
        dispute = await self._disputes.get(dispute_id, lock=True)
        if job is None or dispute is None:  # pragma: no cover - disputes are never deleted
            await self._session.rollback()
            raise NotFoundError
        ids = {"dispute_id": str(dispute.id), "job_id": str(job.job_id)}
        payment = await self._payments.succeeded_of_quote(job.quote_id)
        if (
            payment is None
            or payment.stripe_payment_intent_id is None
            or job.pro_payout_cents <= 0
            or payment.pro_payout_cents != job.pro_payout_cents
            or payment.customer_total_cents < job.pro_payout_cents
            or (dispute.status is DisputeStatus.OPEN and job.status is not JobStatus.DISPUTED)
        ):
            await self._session.rollback()
            logger.error("dispute_payment_mismatch", extra=ids)
            raise DisputeNeedsReviewError
        try:
            plan = _plan(data, job.pro_payout_cents, payment.customer_total_cents)
        except InvalidSplitError:
            await self._session.rollback()
            raise
        return _Locked(
            dispute=dispute,
            job=job,
            payment_id=payment.id,
            payment_intent_id=payment.stripe_payment_intent_id,
            currency=payment.currency,
            plan=plan,
        )

    async def _replay(self, locked: _Locked, queue: JobQueue) -> DisputeResolutionOut:
        """A resolve of a resolved dispute: the same decision completes what may be missing
        (the transfer); another one is refused."""
        same = _same(locked.dispute, locked.plan)
        dispute_id = locked.dispute.id
        await self._session.rollback()
        if not same:
            raise DisputeAlreadyResolvedError
        if locked.plan.pro_release_cents > 0:
            await enqueue_transfer_release(
                queue, locked.job.job_id, self._config.enqueue_timeout_seconds
            )
        return await self._outcome(dispute_id)

    async def _release(
        self, admin: UserAccount, locked: _Locked, note: str, queue: JobQueue
    ) -> DisputeResolutionOut:
        """A full release: resolved now, the transfer queued after the commit."""
        if await self._refunds.by_key_for_update(dispute_refund_key(locked.dispute.id)):
            # A refund was tried for this dispute and may be in Stripe: not paid twice.
            await self._session.rollback()
            raise RefundAlreadyAttemptedError
        return await self._resolved(admin, locked, note, None, queue)

    async def _refund(
        self, admin: UserAccount, locked: _Locked, data: DisputeResolveIn, queue: JobQueue
    ) -> DisputeResolutionOut:
        """A full or partial refund: steps 1 to 3 of the module doc."""
        if self._stripe is None:
            await self._session.rollback()
            raise PaymentsNotConfiguredError
        attempt = await self._start_refund(locked)
        try:
            made = await make_refund(self._stripe, attempt)
        except RefundNeedsReviewError as error:
            await self._end_failed(attempt, REFUND_NEEDS_REVIEW)
            logger.error(
                "dispute_refund_needs_review", extra={**attempt.ids, "reason": error.reason}
            )
            raise DisputeNeedsReviewError from None
        except StripeCallError as error:
            # Its code, or its class: never its text (stripe_errors.py carries none).
            await self._end_failed(
                attempt, (error.code or type(error).__name__)[:REFUND_ERROR_CODE_LENGTH]
            )
            unavailable = isinstance(error, StripeUnavailableError)
            logger.error(
                "dispute_refund_stripe_unavailable"
                if unavailable
                else "dispute_refund_stripe_rejected",
                extra={
                    **attempt.ids,
                    "stripe_request_id": error.request_id,
                    "stripe_code": error.code,
                },
            )
            raise (PaymentsUnavailableError if unavailable else PaymentsProviderError) from None
        return await self._settle(admin, attempt, made, data, queue)

    async def _start_refund(self, locked: _Locked) -> RefundAttempt:
        """Step 1: the refund row and its attempt, committed before Stripe is called."""
        if await self._transfers.get_of_job(locked.job.job_id) is not None:
            # Only a release makes a transfer, and it resolved the dispute: never both.
            await self._session.rollback()
            logger.error("dispute_refund_job_has_transfer", extra=locked.ids)
            raise DisputeNeedsReviewError
        key = dispute_refund_key(locked.dispute.id)
        refund = await self._refunds.by_key_for_update(key)
        if refund is not None and refund.amount_cents != locked.plan.customer_refund_cents:
            await self._session.rollback()
            raise RefundAlreadyAttemptedError
        if refund is not None and self._in_flight(refund):
            await self._session.rollback()
            raise ResolutionInProgressError
        if refund is None:
            refund = await self._refunds.add(
                Refund(
                    job_id=locked.job.job_id,
                    payment_id=locked.payment_id,
                    dispute_id=locked.dispute.id,
                    # Computed from the frozen amounts (_plan), never from the request.
                    amount_cents=locked.plan.customer_refund_cents,
                    currency=locked.currency,
                    idempotency_key=key,
                )
            )
        number = await self._refunds.start_attempt(refund.id, self._clock())
        if number is None:  # pragma: no cover - created is stored with the resolution, at once
            await self._session.rollback()
            raise DisputeNeedsReviewError
        attempt = RefundAttempt(
            refund_id=refund.id,
            dispute_id=locked.dispute.id,
            job_id=locked.job.job_id,
            payment_id=locked.payment_id,
            payment_intent_id=locked.payment_intent_id,
            amount_cents=refund.amount_cents,
            currency=refund.currency,
            idempotency_key=key,
            number=number,
        )
        # Before any Stripe call: the row and its attempt outlive whatever happens next, and
        # the locks end here.
        await self._session.commit()
        return attempt

    def _in_flight(self, refund: Refund) -> bool:
        """An attempt was stamped, has no outcome yet, and is too recent to be lost."""
        return (
            refund.status is RefundStatus.PENDING
            and refund.last_error_code is None
            and refund.requested_at is not None
            and self._clock() - refund.requested_at < self._config.stuck_after
        )

    async def _settle(
        self,
        admin: UserAccount,
        attempt: RefundAttempt,
        made: RefundFacts,
        data: DisputeResolveIn,
        queue: JobQueue,
    ) -> DisputeResolutionOut:
        """Step 3: the refund stored and the dispute resolved, in one transaction."""
        locked = await self._lock(attempt.dispute_id, data)
        if locked.dispute.status is DisputeStatus.RESOLVED:
            # Another attempt of the same refund (one key) settled it first.
            await self._session.rollback()
            return await self._outcome(attempt.dispute_id)
        if not await self._refunds.mark_created(attempt.refund_id, made.refund_id):
            # pragma: no cover - created is stored with the resolution, under these locks
            await self._session.rollback()
            logger.error("dispute_refund_stored_dispute_open", extra=attempt.ids)
            raise DisputeNeedsReviewError
        logger.info(
            "dispute_refund_created", extra={**attempt.ids, "stripe_request_id": made.request_id}
        )
        return await self._resolved(admin, locked, data.note, made.refund_id, queue)

    async def _resolved(
        self,
        admin: UserAccount,
        locked: _Locked,
        note: str,
        stripe_refund_id: str | None,
        queue: JobQueue,
    ) -> DisputeResolutionOut:
        """The dispute resolved, the job refunded (a full refund) and the audit row, committed
        together; then the transfer queued (a release, full or partial) and both sides pushed."""
        dispute, job, plan = locked.dispute, locked.job, locked.plan
        dispute_id = dispute.id
        if not await self._disputes.resolve(
            dispute_id,
            resolution=plan.resolution,
            note=note,
            by=admin.id,
            now=self._clock(),
            pro_release_cents=plan.pro_release_cents,
            customer_refund_cents=plan.customer_refund_cents,
        ):  # pragma: no cover - the dispute is locked and was read open
            await self._session.rollback()
            raise DisputeAlreadyResolvedError
        if plan.resolution is DisputeResolution.REFUNDED:
            await self._jobs.refunded(job.job_id, admin)
        try:
            # In the change's transaction: an audit write that fails rolls it back.
            await self._audit.record(
                Operator(admin.id, reason=note),
                AuditAction.DISPUTE_RESOLVE,
                AuditEntity(AuditEntityType.DISPUTE, dispute_id),
                {"status": DisputeStatus.OPEN.value, "job_status": job.status.value},
                {
                    "status": DisputeStatus.RESOLVED.value,
                    "resolution": plan.resolution.value,
                    "job_id": str(job.job_id),
                    "pro_release_cents": plan.pro_release_cents,
                    "customer_refund_cents": plan.customer_refund_cents,
                    "stripe_refund_id": stripe_refund_id,
                },
            )
        except OperatorNotAdminError:
            await self._session.rollback()
            raise ForbiddenError from None
        public_code = await self._requests.public_code(job.request_id)
        await self._session.commit()
        logger.info(
            "dispute_resolved",
            extra={
                "dispute_id": str(dispute_id),
                "job_id": str(job.job_id),
                "admin_id": str(admin.id),
                "resolution": plan.resolution.value,
            },
        )
        timeout = self._config.enqueue_timeout_seconds
        if plan.pro_release_cents > 0:
            await enqueue_transfer_release(queue, job.job_id, timeout)
        to_customer, to_pro = _PUSHES[plan.resolution]
        await to_customer(
            queue,
            customer_id=job.customer_id,
            job_id=job.job_id,
            request_id=job.request_id,
            public_code=public_code,
            timeout_seconds=timeout,
        )
        await to_pro(
            queue,
            pro_user_id=job.pro_user_id,
            job_id=job.job_id,
            public_code=public_code,
            timeout_seconds=timeout,
        )
        return await self._outcome(dispute_id)

    async def _end_failed(self, attempt: RefundAttempt, code: str) -> None:
        await self._refunds.mark_failed(attempt.refund_id, attempt.number, code)
        await self._session.commit()

    async def _outcome(self, dispute_id: uuid.UUID) -> DisputeResolutionOut:
        """Where the dispute stands, as last committed. Ends its transaction."""
        dispute = await self._disputes.get(dispute_id)
        if dispute is None:  # pragma: no cover - disputes are never deleted
            raise NotFoundError
        jobs = await self._jobs.read_many([dispute.job_id])
        refund = await self._refunds.of_dispute(dispute_id)
        # Built before the rollback, which expires the rows.
        out = DisputeResolutionOut(
            id=dispute.id,
            job_id=dispute.job_id,
            status=dispute.status,
            resolution=dispute.resolution,
            pro_release_cents=dispute.pro_release_cents,
            customer_refund_cents=dispute.customer_refund_cents,
            resolved_at=dispute.resolved_at,
            job_status=jobs[dispute.job_id].status,
            refund=None if refund is None else RefundOut.model_validate(refund),
        )
        await self._session.rollback()
        return out
