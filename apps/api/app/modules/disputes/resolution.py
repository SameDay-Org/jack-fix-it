"""An admin resolves a dispute (#76; D15.3, D15.4): the pro paid, the customer refunded, or a
split of the two.

- release: the pro's frozen payout in full, no refund. The dispute is resolved at once; the
  job's transfer follows (payments.transfers.TransferService.release: queued after the commit,
  and the transfer sweep for whatever that leaves), which moves the job disputed -> paid_out as
  the admin who decided.
- refund: the customer's total (tax included) back to their payment method, no transfer. The
  job moves disputed -> refunded, as the admin who decided.
- partial: the admin names pro_release_cents, strictly between 0 and the payout. The customer
  gets back app.money.partial_refund_cents (the share of their total the pro is not paid,
  rounded half up); the platform keeps the rest (its fee and the tax in proportion). The
  refund first, then the transfer as for a release.

Money: every amount comes from the job's frozen payout and its succeeded payment; the client
names only pro_release_cents, checked against them. The platform absorbs Stripe's fees.

A refund, in three steps (no transaction or lock is held across a Stripe call):
1. Under the job's row lock (the one every status change takes), then the dispute's: the
   checks, the refund row (pending, key `dispute:<id>:refund`, unique: one refund per
   dispute, with the decision it carries out: the deciding admin, the pro's part, the note)
   and its attempt stamped, and the audit row of the request (dispute.refund_request: the
   admin, the decision, the amounts, the attempt and its key; #433 round 1 B2), all
   COMMITTED before any Stripe call. Money never moves before its request is audited.
2. Stripe (payments.refunds.make_refund): an attempt after the first looks for the refund of
   a lost answer before it creates one; the create carries the key. Once Stripe answered with
   a refund, no attempt is ever started again: the same decision reads that refund again by
   its id (payments.refunds.recheck_refund), audited as a request too.
3. Under the same locks, one transaction (RefundSettlement.apply): Stripe's refund and its
   status stored on the row, and then, only if Stripe says `succeeded` (#433 round 1 B1): the
   dispute resolved, the job refunded (full refund), the audit row (dispute.resolve). After
   the commit the partial's transfer is queued and both sides are pushed. Stripe not finished
   (pending, requires_action): the dispute stays open, nothing else moves, 409 refund_pending;
   the same decision, or Stripe's refund events (refund_webhooks.py), settle it later. Stripe
   failed or canceled it: the dispute stays open, any payout stays held, 409 refund_failed;
   staff repair it (#434). Either is audited once (dispute.refund_outcome).
A Stripe error stores the row failed with Stripe's code (never its text), audits the outcome
(dispute.refund_outcome, committed before the answer) and answers 502/503: the dispute stays
open and the job disputed; the same decision tries again. Stripe keeps the answer of a request
it ran under the key for 24 h, refusals included, so a retry before then gets the same refusal:
it helps when the call never reached Stripe (network, timeout, 409, 429). A crash after the
Stripe call leaves the request's audit row naming the admin, and the row's attempt.
The refund rows live in payments (RefundLedger, ADR 0003).

Who: the dispute is resolved by (resolved_by) the admin whose decision it is, the refund row's
initiated_by, whoever settles it. An admin who sends the same decision again for a dispute
another admin's refund left open is audited under their own id, `recovery` true and the
deciding admin named; Stripe's event settles under the deciding admin, naming the event.

Authorization at settling time (#433 round 2): an admin's request is checked before Stripe (the
request's audit row) and again in the settling transaction, after Stripe answered and before
anything settles (AuditService.active_admin: the account as last committed, share-locked until
the commit). An admin demoted or suspended meanwhile gets 403 and nothing settles: no dispute
resolved, no job moved, no transfer queued, no push, no dispute.resolve row. What Stripe said
is still stored on the refund row (the refund stays recoverable: another admin's same decision,
or Stripe's event, settles it), and the refusal is audited (dispute.refund_outcome,
`admin_not_active`). Stripe's event has no acting admin: it completes the request the deciding
admin was authorized for when it was audited, before Stripe, with no check again.

Once: a resolved dispute answers the same decision (and split) with where it stands, queueing
its transfer again (the sweep would too) and pushing nothing; another decision is 409
dispute_already_resolved. While the dispute is open with a refund row, only the same decision
is tried again (409 refund_already_attempted: Stripe may hold it), and not while an attempt is
under way (409 resolution_in_progress, for REFUND_STUCK_PENDING_MINUTES). Two admins at once:
the job's lock orders them, and the second reads what the first committed.

Audit: through AuditService (an active admin: money). The request with `record` (the role
checked again); its outcome and the settlement with `record_outcome` (the admin was checked when
asking, and the money moved whatever their role is now). The note is the reason of the rows the
admin's own request writes. Each side is pushed once, after the commit (one kind per decision),
never with the note. Logs carry ids and the decision only: no amount, no note, no Stripe object
id.
"""

import logging
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Final, Protocol

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import ForbiddenError, NotFoundError
from app.integrations.stripe_errors import (
    StripeCallError,
    StripeRejectedError,
    StripeUnavailableError,
)
from app.integrations.stripe_refunds import RefundFacts, StripeRefunds
from app.modules.audit.service import AuditService
from app.modules.audit.types import (
    AuditAction,
    AuditEntity,
    AuditEntityType,
    AuditState,
    AuditValue,
    Operator,
    OperatorNotAdminError,
)
from app.modules.disputes.errors import (
    DisputeAlreadyResolvedError,
    DisputeNeedsReviewError,
    InvalidSplitError,
    RefundAlreadyAttemptedError,
    RefundFailedError,
    RefundPendingError,
    ResolutionInProgressError,
)
from app.modules.disputes.models import Dispute, DisputeResolution, DisputeStatus
from app.modules.disputes.repository import DisputeRepository
from app.modules.disputes.staff_schemas import (
    DisputeResolutionOut,
    DisputeResolveIn,
    ResolutionDecision,
)
from app.modules.jobs.service import AdminDecision, JobDisputeFacts, JobDisputes, JobStatus
from app.modules.notifications.events import (
    push_dispute_closed,
    push_dispute_partly_refunded,
    push_dispute_payout_partly_released,
    push_dispute_payout_refunded,
    push_dispute_payout_released,
    push_dispute_refunded,
)
from app.modules.payments.errors import PaymentsNotConfiguredError
from app.modules.payments.refunds import (
    REFUND_CODE_LENGTH,
    REFUND_NEEDS_REVIEW,
    DisputeRefund,
    PaymentFacts,
    RefundAttempt,
    RefundBlocked,
    RefundDecision,
    RefundLedger,
    RefundNeedsReviewError,
    make_refund,
    recheck_refund,
    refund_fits,
)
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

    @classmethod
    def of_refund(cls, refund: DisputeRefund) -> "_Plan":
        """The decision a refund row carries out: a full refund releases nothing."""
        resolution = (
            DisputeResolution.REFUNDED
            if refund.pro_release_cents == 0
            else DisputeResolution.PARTIAL_RELEASE
        )
        return cls(resolution, refund.pro_release_cents, refund.amount_cents)


@dataclass(frozen=True)
class Locked:
    """The dispute and its job under their locks, and the job's payment. `dispute` is an ORM
    row: read it before the transaction ends (a rollback expires it); the rest are plain
    values."""

    dispute: Dispute
    dispute_id: uuid.UUID
    job: JobDisputeFacts
    payment: PaymentFacts

    @property
    def ids(self) -> dict[str, str]:
        return {"dispute_id": str(self.dispute_id), "job_id": str(self.job.job_id)}


@dataclass(frozen=True)
class RefundActor:
    """Who a refund's outcome is recorded under: the admin acting now (their request; `reason`
    their note), or the admin whose decision it is when Stripe's event settles it
    (`stripe_event_id`)."""

    user_id: uuid.UUID
    reason: str | None = None
    stripe_event_id: str | None = None

    @property
    def system(self) -> bool:
        """Stripe's event settles it: no admin acts now (`user_id` is the deciding admin)."""
        return self.stripe_event_id is not None


class Applied(StrEnum):
    """What Stripe's status of a dispute's refund did (RefundSettlement.apply)."""

    # Succeeded: the dispute is resolved now.
    SETTLED = "settled"
    # Not finished (pending, requires_action): the dispute stays open.
    PENDING = "pending"
    # Failed or canceled: the dispute stays open (or, resolved already, is flagged) for staff.
    FAILED = "failed"
    # Succeeded, and the dispute was resolved already: nothing to do.
    UNCHANGED = "unchanged"
    # The acting admin is no longer an active admin: Stripe's word stored, nothing settled.
    NOT_AUTHORIZED = "not_authorized"


@dataclass(frozen=True)
class Announcement:
    """What a resolution announces once it is committed: the transfer queued (a release, full
    or partial) and both sides pushed. Never raises for a queue failure (the sweep releases the
    job; a push is logged and dropped)."""

    job: JobDisputeFacts
    resolution: DisputeResolution
    release: bool
    public_code: str

    async def __call__(self, queue: JobQueue, timeout_seconds: float) -> None:
        if self.release:
            await enqueue_transfer_release(queue, self.job.job_id, timeout_seconds)
        to_customer, to_pro = _PUSHES[self.resolution]
        await to_customer(
            queue,
            customer_id=self.job.customer_id,
            job_id=self.job.job_id,
            request_id=self.job.request_id,
            public_code=self.public_code,
            timeout_seconds=timeout_seconds,
        )
        await to_pro(
            queue,
            pro_user_id=self.job.pro_user_id,
            job_id=self.job.job_id,
            public_code=self.public_code,
            timeout_seconds=timeout_seconds,
        )


@dataclass(frozen=True)
class Application:
    applied: Applied
    # SETTLED only: to run after the commit.
    announce: Announcement | None = None


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


def _entity(dispute_id: uuid.UUID) -> AuditEntity:
    return AuditEntity(AuditEntityType.DISPUTE, dispute_id)


class RefundSettlement:
    """Stripe's word on a dispute's refund, applied: one path for an admin's resolve and for
    Stripe's refund events (refund_webhooks.py). Runs in the caller's transaction, under the
    locks it takes there; never commits or rolls back (the caller ends the transaction, and on
    an error rolls it back)."""

    def __init__(self, session: AsyncSession, clock: Callable[[], datetime] = utc_now) -> None:
        self._clock = clock
        self._disputes = DisputeRepository(session)
        self._ledger = RefundLedger(session)
        self._jobs = JobDisputes(session, ProService(session))
        self._requests = CustomerRequestReader(session)
        self._audit = AuditService(session)

    async def lock(self, dispute_id: uuid.UUID) -> Locked:
        """The job's row lock, then the dispute's, each read as last committed; the job's
        payment, checked against the job. NotFoundError, or DisputeNeedsReviewError when the
        payment does not match the job."""
        found = await self._disputes.get(dispute_id)
        if found is None:
            raise NotFoundError
        job = await self._jobs.locked(found.job_id)
        dispute = await self._disputes.get(dispute_id, lock=True)
        if job is None or dispute is None:  # pragma: no cover - disputes are never deleted
            raise NotFoundError
        payment = await self._ledger.payment_of_quote(job.quote_id)
        if (
            payment is None
            or payment.payment_intent_id is None
            or job.pro_payout_cents <= 0
            or payment.pro_payout_cents != job.pro_payout_cents
            or payment.customer_total_cents < job.pro_payout_cents
            or (dispute.status is DisputeStatus.OPEN and job.status is not JobStatus.DISPUTED)
        ):
            logger.error(
                "dispute_payment_mismatch",
                extra={"dispute_id": str(dispute.id), "job_id": str(job.job_id)},
            )
            raise DisputeNeedsReviewError
        return Locked(dispute=dispute, dispute_id=dispute.id, job=job, payment=payment)

    async def apply(
        self, locked: Locked, refund: DisputeRefund, read: RefundFacts, actor: RefundActor
    ) -> Application:
        """Stores Stripe's refund and its status on the row (`refund` read under its lock in
        this transaction, `read` checked to fit it; a read older than the row's status does not
        replace it: the readers read Stripe before they take the locks). An admin's request
        whose admin is no longer an active admin then stops (NOT_AUTHORIZED, audited); else, by
        the row's status: succeeded with the dispute open
        settles it (SETTLED, with what to announce after the commit); succeeded with it resolved
        is UNCHANGED; failed or canceled is FAILED (an error logged for staff); anything else is
        PENDING. A status new for the row that settles nothing is audited once
        (dispute.refund_outcome)."""
        # Stripe's status as the row holds it now: a read older than the row's never wins.
        observed = await self._ledger.observe(refund, read)
        # An admin's request is authorized again here, after Stripe and before anything
        # settles (round 2). Stripe's event is not: it has no acting admin, and completes the
        # request the deciding admin was authorized for, and audited, before Stripe was called.
        if not actor.system and not await self._audit.active_admin(actor.user_id):
            logger.warning(
                "dispute_resolve_admin_not_active",
                extra={**refund.ids, "admin_id": str(actor.user_id)},
            )
            await self.record_outcome(
                actor,
                refund.dispute_id,
                {
                    "outcome": "admin_not_active",
                    "refund_id": str(refund.refund_id),
                    "stripe_refund_id": read.refund_id,
                    "stripe_status": observed.status,
                    "dispute_status": locked.dispute.status.value,
                },
            )
            return Application(Applied.NOT_AUTHORIZED)
        if observed.succeeded:
            if locked.dispute.status is DisputeStatus.RESOLVED:
                return Application(Applied.UNCHANGED)
            return Application(Applied.SETTLED, await self._settle(locked, refund, read, actor))
        if observed.changed:
            if observed.dead:
                # For staff (#434): the money did not go back, and any payout stays held.
                logger.error(
                    "dispute_refund_failed",
                    extra={**refund.ids, "dispute_status": locked.dispute.status.value},
                )
            await self.record_outcome(
                actor,
                refund.dispute_id,
                {
                    "outcome": "refund_failed" if observed.dead else "refund_pending",
                    "refund_id": str(refund.refund_id),
                    "stripe_refund_id": read.refund_id,
                    "stripe_status": observed.status,
                    "dispute_status": locked.dispute.status.value,
                },
            )
        return Application(Applied.FAILED if observed.dead else Applied.PENDING)

    async def write_resolution(
        self, locked: Locked, plan: _Plan, *, by: uuid.UUID, note: str
    ) -> tuple[AuditState, AuditState]:
        """The dispute resolved by the admin `by` whose decision it is, and the job refunded
        for a full refund; the audit row's before and after. Flushes, never commits."""
        job = locked.job
        if not await self._disputes.resolve(
            locked.dispute_id,
            resolution=plan.resolution,
            note=note,
            by=by,
            now=self._clock(),
            pro_release_cents=plan.pro_release_cents,
            customer_refund_cents=plan.customer_refund_cents,
        ):  # pragma: no cover - the dispute is locked and was read open
            raise DisputeAlreadyResolvedError
        if plan.resolution is DisputeResolution.REFUNDED:
            await self._jobs.refunded(job.job_id, AdminDecision(by))
        before: AuditState = {"status": DisputeStatus.OPEN.value, "job_status": job.status.value}
        after: AuditState = {
            "status": DisputeStatus.RESOLVED.value,
            "resolution": plan.resolution.value,
            "job_id": str(job.job_id),
            "pro_release_cents": plan.pro_release_cents,
            "customer_refund_cents": plan.customer_refund_cents,
        }
        return before, after

    async def announcement(self, locked: Locked, plan: _Plan) -> Announcement:
        return Announcement(
            job=locked.job,
            resolution=plan.resolution,
            release=plan.pro_release_cents > 0,
            public_code=await self._requests.public_code(locked.job.request_id),
        )

    async def record_outcome(
        self, actor: RefundActor, dispute_id: uuid.UUID, after: Mapping[str, AuditValue]
    ) -> None:
        await self._audit.record_outcome(
            actor.user_id,
            AuditAction.DISPUTE_REFUND_OUTCOME,
            _entity(dispute_id),
            {},
            {**after, "stripe_event_id": actor.stripe_event_id},
            reason=actor.reason,
        )

    async def _settle(
        self, locked: Locked, refund: DisputeRefund, read: RefundFacts, actor: RefundActor
    ) -> Announcement:
        """Stripe says the money is back: the decision the row carries out, applied now, under
        the admin who took it."""
        plan = _Plan.of_refund(refund)
        before, after = await self.write_resolution(
            locked, plan, by=refund.initiated_by, note=refund.resolution_note
        )
        await self._audit.record_outcome(
            actor.user_id,
            AuditAction.DISPUTE_RESOLVE,
            _entity(locked.dispute_id),
            before,
            {
                **after,
                "refund_id": str(refund.refund_id),
                "stripe_refund_id": read.refund_id,
                "stripe_status": read.status,
                "initiated_by": str(refund.initiated_by),
                "recovery": actor.user_id != refund.initiated_by,
                # True: Stripe's event settled the deciding admin's audited request.
                "system": actor.system,
                "stripe_event_id": actor.stripe_event_id,
            },
            reason=actor.reason,
        )
        logger.info(
            "dispute_resolved",
            extra={
                **locked.ids,
                "admin_id": str(refund.initiated_by),
                "actor_id": str(actor.user_id),
                "resolution": plan.resolution.value,
                "stripe_request_id": read.request_id,
            },
        )
        return await self.announcement(locked, plan)


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
        self._ledger = RefundLedger(session)
        self._jobs = JobDisputes(session, ProService(session))
        self._audit = AuditService(session)
        self._settlement = RefundSettlement(session, clock)

    async def resolve(
        self, admin: UserAccount, dispute_id: uuid.UUID, data: DisputeResolveIn, queue: JobQueue
    ) -> DisputeResolutionOut:
        """Applies the admin's decision once (see the module doc). Ends every transaction it
        opens."""
        locked = await self._lock(dispute_id)
        try:
            plan = _plan(data, locked.job.pro_payout_cents, locked.payment.customer_total_cents)
        except InvalidSplitError:
            await self._session.rollback()
            raise
        if locked.dispute.status is DisputeStatus.RESOLVED:
            return await self._replay(locked, plan, queue)
        if plan.customer_refund_cents == 0:
            return await self._release(admin, locked, plan, data.note, queue)
        return await self._refund(admin, locked, plan, data.note, queue)

    async def _lock(self, dispute_id: uuid.UUID) -> Locked:
        """RefundSettlement.lock; on a refusal, the transaction rolled back first."""
        try:
            return await self._settlement.lock(dispute_id)
        except (NotFoundError, DisputeNeedsReviewError):
            await self._session.rollback()
            raise

    async def _replay(self, locked: Locked, plan: _Plan, queue: JobQueue) -> DisputeResolutionOut:
        """A resolve of a resolved dispute: the same decision completes what may be missing
        (the transfer); another one is refused."""
        same = _same(locked.dispute, plan)
        await self._session.rollback()
        if not same:
            raise DisputeAlreadyResolvedError
        if plan.pro_release_cents > 0:
            await enqueue_transfer_release(
                queue, locked.job.job_id, self._config.enqueue_timeout_seconds
            )
        return await self._outcome(locked.dispute_id)

    async def _release(
        self, admin: UserAccount, locked: Locked, plan: _Plan, note: str, queue: JobQueue
    ) -> DisputeResolutionOut:
        """A full release: resolved now, the transfer queued after the commit."""
        if await self._ledger.attempted(locked.dispute_id):
            # A refund was tried for this dispute and may be in Stripe: not paid twice.
            await self._session.rollback()
            raise RefundAlreadyAttemptedError
        before, after = await self._settlement.write_resolution(
            locked, plan, by=admin.id, note=note
        )
        try:
            # In the change's transaction: an audit write that fails rolls it back.
            await self._audit.record(
                Operator(admin.id, reason=note),
                AuditAction.DISPUTE_RESOLVE,
                _entity(locked.dispute_id),
                before,
                after,
            )
        except OperatorNotAdminError:
            await self._session.rollback()
            raise ForbiddenError from None
        announce = await self._settlement.announcement(locked, plan)
        await self._session.commit()
        logger.info(
            "dispute_resolved",
            extra={
                **locked.ids,
                "admin_id": str(admin.id),
                "resolution": plan.resolution.value,
            },
        )
        await announce(queue, self._config.enqueue_timeout_seconds)
        return await self._outcome(locked.dispute_id)

    async def _refund(
        self, admin: UserAccount, locked: Locked, plan: _Plan, note: str, queue: JobQueue
    ) -> DisputeResolutionOut:
        """A full or partial refund: steps 1 to 3 of the module doc."""
        if self._stripe is None:
            await self._session.rollback()
            raise PaymentsNotConfiguredError
        started = await self._start_refund(admin, locked, plan, note)
        actor = RefundActor(admin.id, reason=note)
        try:
            read = await self._ask_stripe(self._stripe, started)
        except RefundNeedsReviewError as error:
            await self._end_without_refund(actor, started, REFUND_NEEDS_REVIEW, "needs_review")
            logger.error(
                "dispute_refund_needs_review",
                extra={**locked.ids, "reason": error.reason},
            )
            raise DisputeNeedsReviewError from None
        except StripeCallError as error:
            # Its code, or its class: never its text (stripe_errors.py carries none).
            unavailable = isinstance(error, StripeUnavailableError)
            await self._end_without_refund(
                actor,
                started,
                error.code or type(error).__name__,
                "unavailable" if unavailable else "rejected",
                # Stripe's definitive answer: a 4xx with its code (stripe_errors.raise_typed).
                definitive=isinstance(error, StripeRejectedError) and error.code is not None,
            )
            logger.error(
                "dispute_refund_stripe_unavailable"
                if unavailable
                else "dispute_refund_stripe_rejected",
                extra={
                    **locked.ids,
                    "stripe_request_id": error.request_id,
                    "stripe_code": error.code,
                },
            )
            raise (PaymentsUnavailableError if unavailable else PaymentsProviderError) from None
        return await self._after_stripe(locked.dispute_id, read, actor, queue)

    async def _start_refund(
        self, admin: UserAccount, locked: Locked, plan: _Plan, note: str
    ) -> RefundAttempt | DisputeRefund:
        """Step 1: the refund row and its attempt (or the refund Stripe holds, to read again),
        and the request's audit row, committed before Stripe is called."""
        if await self._ledger.job_has_transfer(locked.job.job_id):
            # Only a release makes a transfer, and it resolved the dispute: never both.
            await self._session.rollback()
            logger.error("dispute_refund_job_has_transfer", extra=locked.ids)
            raise DisputeNeedsReviewError
        started = await self._ledger.start_attempt(
            dispute_id=locked.dispute_id,
            job_id=locked.job.job_id,
            payment=locked.payment,
            # Computed from the frozen amounts (_plan), never from the request.
            decision=RefundDecision(
                initiated_by=admin.id,
                amount_cents=plan.customer_refund_cents,
                pro_release_cents=plan.pro_release_cents,
                resolution_note=note,
            ),
            now=self._clock(),
            stuck_after=self._config.stuck_after,
        )
        if isinstance(started, RefundBlocked):
            await self._session.rollback()
            if started is RefundBlocked.ANOTHER_DECISION:
                raise RefundAlreadyAttemptedError
            if started is RefundBlocked.IN_FLIGHT:
                raise ResolutionInProgressError
            raise RefundFailedError
        attempt = started if isinstance(started, RefundAttempt) else None
        try:
            # In the attempt's transaction: no Stripe call without its audited request.
            await self._audit.record(
                Operator(admin.id, reason=note),
                AuditAction.DISPUTE_REFUND_REQUEST,
                _entity(locked.dispute_id),
                {"status": DisputeStatus.OPEN.value, "job_status": locked.job.status.value},
                {
                    "step": "create" if attempt is not None else "recheck",
                    "resolution": plan.resolution.value,
                    "job_id": str(locked.job.job_id),
                    "pro_release_cents": plan.pro_release_cents,
                    "customer_refund_cents": plan.customer_refund_cents,
                    "refund_id": str(started.refund_id),
                    "idempotency_key": started.idempotency_key,
                    "attempt": None if attempt is None else attempt.number,
                    "stripe_refund_id": (
                        started.stripe_refund_id if isinstance(started, DisputeRefund) else None
                    ),
                    "initiated_by": str(started.initiated_by),
                    "recovery": admin.id != started.initiated_by,
                },
            )
        except OperatorNotAdminError:
            await self._session.rollback()
            raise ForbiddenError from None
        # Before any Stripe call: the row, its attempt and the audited request outlive whatever
        # happens next, and the locks end here.
        await self._session.commit()
        return started

    @staticmethod
    async def _ask_stripe(
        stripe: StripeRefunds, started: RefundAttempt | DisputeRefund
    ) -> RefundFacts:
        """Step 2: a new attempt finds or creates the refund; a refund Stripe holds is read
        again by its id."""
        if isinstance(started, RefundAttempt):
            return await make_refund(stripe, started)
        return await recheck_refund(stripe, started)

    async def _end_without_refund(
        self,
        actor: RefundActor,
        started: RefundAttempt | DisputeRefund,
        code: str,
        outcome: str,
        *,
        definitive: bool = False,
    ) -> None:
        """No refund came back from Stripe: the attempt ended failed (a read of a held refund
        leaves the row as it is) and the outcome audited, committed before the answer."""
        if isinstance(started, RefundAttempt):
            await self._ledger.failed(started, code, definitive=definitive)
        await self._settlement.record_outcome(
            actor,
            started.dispute_id,
            {
                "outcome": outcome,
                "code": code[:REFUND_CODE_LENGTH],
                "refund_id": str(started.refund_id),
                "attempt": started.number if isinstance(started, RefundAttempt) else None,
            },
        )
        await self._session.commit()

    async def _after_stripe(
        self, dispute_id: uuid.UUID, read: RefundFacts, actor: RefundActor, queue: JobQueue
    ) -> DisputeResolutionOut:
        """Step 3: what Stripe said, applied under the locks in one transaction."""
        locked = await self._lock(dispute_id)
        refund = await self._ledger.locked_of_dispute(dispute_id)
        if refund is None:  # pragma: no cover - refund rows are never deleted
            await self._session.rollback()
            raise DisputeNeedsReviewError
        try:
            applied = await self._settlement.apply(locked, refund, refund_fits(read, refund), actor)
        except RefundNeedsReviewError as error:
            await self._session.rollback()
            logger.error(
                "dispute_refund_needs_review", extra={**refund.ids, "reason": error.reason}
            )
            raise DisputeNeedsReviewError from None
        # Committed whatever came of it: Stripe's word, and the refusal's audit row too.
        await self._session.commit()
        if applied.applied is Applied.NOT_AUTHORIZED:
            raise ForbiddenError
        if applied.applied is Applied.PENDING:
            raise RefundPendingError
        if applied.applied is Applied.FAILED:
            raise RefundFailedError
        if applied.announce is not None:
            await applied.announce(queue, self._config.enqueue_timeout_seconds)
        return await self._outcome(dispute_id)

    async def _outcome(self, dispute_id: uuid.UUID) -> DisputeResolutionOut:
        """Where the dispute stands, as last committed. Ends its transaction."""
        dispute = await self._disputes.get(dispute_id)
        if dispute is None:  # pragma: no cover - disputes are never deleted
            raise NotFoundError
        jobs = await self._jobs.read_many([dispute.job_id])
        refund = await self._ledger.of_dispute(dispute_id)
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
            refund=refund,
        )
        await self._session.rollback()
        return out
