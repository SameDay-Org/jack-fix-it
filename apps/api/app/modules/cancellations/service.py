"""A job cancelled by its customer or by its pro (#69, D13; Cesar 2026-10-29): for the
customer, free before the pro's "On my way" and a fee after it; for the pro, never a charge to
the customer; never once the work started.

- Who: the job's customer (POST /v1/jobs/{id}/cancel) or the job's pro
  (POST /v1/pros/me/jobs/{id}/cancel). Each route takes its own role (anyone else 403);
  another customer's or pro's job and an unknown job are the same 404.
- When: the job is scheduled or on the way, arrived included. Anything else is 409
  `cancel_not_allowed`, its status in the message: once the work started, or the job is done,
  the customer reports a problem instead (#75).
- How much (app.money.cancellation_split): the customer's fee is CANCELLATION_FEE_BPS of the
  job price (the payment's amount_cents: the quote's amount before tax, the base the take rate
  uses), rounded half up, once the pro is on the way, and 0 before; a pro's cancel never
  charges the customer: fee 0, whatever the job's status. The refund is the rest of what the
  customer paid, tax included (all of it after a pro's cancel). There is no separate charge:
  the fee is the part not refunded. Both computed here from the job's payment, never from the
  body. The customer's preview (GET .../cancel-preview) computes the same on its own read;
  the cancel computes again under the job's lock, and when the body names the fee the preview
  showed (expected_fee_cents) a different fee is refused (409 `cancel_fee_changed`).
- Once: one cancellation per job (UNIQUE job_id). The cancel runs under the job's row lock, so
  a second one, one after the other or at the same time, finds the first and returns it as it
  is now (200 either way). Idempotency-Key as POST /v1/requests (app.idempotency): optional;
  the same key with another body, or on another job, is 409 `idempotency_key_reused`.
- Atomic: the cancellation row, the refund's intent (a refunds row: no attempt yet), the job's
  move to cancelled (JobStateMachine, the cancelling side as actor, one job_events row; the
  pro's live position ends with on_the_way), the request's close (accepted -> cancelled: the
  customer as actor after their own cancel, the system after the pro's, since pros never move
  a request; never reopened, the customer's way back is a new request) and the `job.cancel`
  audit row commit together or not at all. The cancellation row records a pro's cancel against
  them (party, reason, job): no penalty here. For OPS_PRO_CANCEL_ATTENTION_HOURS the BDC's
  queue shows the request under problems (`pro_cancelled_job_ids`).
- After the commit: the refund is queued for the worker (payments.cancel_refunds makes it
  through #433's machinery: settled at Stripe's `succeeded`, retried by a sweep). After the
  customer's cancel the pro and the customer are pushed; after the pro's, the customer (their
  pro cancelled, the payment goes back, a new request whenever they like). A queue failure is
  logged with ids and never fails the cancel. A replay queues the refund again while it has
  not settled.
- The pro's transfer never happens: a cancelled job is never confirmed, and payments.transfers
  releases confirmed jobs only. A job that has a transfer anyway is refused (staff look).
- The note goes through the chat's contact redaction (app.redaction); only the masked text is
  stored, and never logged. Logs carry ids, statuses and amounts.
"""

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final

from sqlalchemy import Select, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db import violated_constraint
from app.errors import NotFoundError
from app.idempotency import body_fingerprint, same_body
from app.modules.audit.service import AuditService
from app.modules.audit.types import AuditAction, AuditEntity, AuditEntityType
from app.modules.cancellations.errors import (
    CancelFeeChangedError,
    CancelNeedsReviewError,
    CancelNotAllowedError,
    IdempotencyKeyReusedError,
    InvalidCancelInputError,
)
from app.modules.cancellations.models import (
    IDEMPOTENCY_KEY_INDEX,
    NOTE_MAX_LENGTH,
    ONE_PER_JOB,
    CancelledFrom,
    CancelParty,
    CancelReason,
    JobCancellation,
)
from app.modules.cancellations.repository import CancellationRepository
from app.modules.cancellations.schemas import (
    CancellationOut,
    CancelPreviewOut,
    CustomerCancelIn,
    ProCancelIn,
    ProCancellationOut,
)
from app.modules.jobs.location import JobLocationStore
from app.modules.jobs.service import SYSTEM, JobCancelFacts, JobCancellations, JobStatus
from app.modules.notifications.events import (
    push_job_cancelled,
    push_job_cancelled_by_customer,
    push_job_cancelled_by_pro,
)
from app.modules.payments.cancel_refund_tasks import enqueue_cancel_refund
from app.modules.payments.cancel_refunds import CancelRefunds, CancelRefundState
from app.modules.payments.refunds import PaymentFacts, RefundLedger
from app.modules.pros.service import ProService
from app.modules.requests.service import CustomerRequestReader
from app.modules.requests.state_machine import RequestStateMachine, RequestStatus
from app.modules.users.types import UserAccount
from app.money import CancellationSplit, cancellation_split
from app.queue import JobQueue
from app.redaction import redact_contacts

logger = logging.getLogger(__name__)

# Where a job may still be cancelled, and the status it is cancelled from.
CANCELLABLE: Final = {
    JobStatus.SCHEDULED: CancelledFrom.SCHEDULED,
    JobStatus.ON_THE_WAY: CancelledFrom.ON_THE_WAY,
}


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class CancelConfig:
    # The fee once the pro is on the way, in basis points of the job price.
    fee_bps: int
    enqueue_timeout_seconds: float

    @classmethod
    def from_settings(cls, settings: Settings) -> "CancelConfig":
        return cls(
            fee_bps=settings.cancellation_fee_bps,
            enqueue_timeout_seconds=settings.job_enqueue_timeout_seconds,
        )


@dataclass(frozen=True)
class _Idempotency:
    key: uuid.UUID
    fingerprint: str


@dataclass(frozen=True)
class _Ask:
    """One cancel as its side sent it: who, why, the note as stored, the key, and the fee the
    customer was shown (None: not checked)."""

    party: CancelParty
    reason: CancelReason
    note: str | None
    idempotency: _Idempotency | None
    expected_fee_cents: int | None = None


def pro_cancelled_job_ids(within: timedelta) -> Select[uuid.UUID]:
    """The jobs their pro cancelled less than `within` ago, by the database clock: for the BDC's
    queue, which shows their requests under problems for that long (#69,
    OPS_PRO_CANCEL_ATTENTION_HOURS)."""
    return select(JobCancellation.job_id).where(
        JobCancellation.party == CancelParty.PRO,
        JobCancellation.created_at > func.now() - within,
    )


class CancellationService:
    def __init__(
        self,
        session: AsyncSession,
        config: CancelConfig,
        locations: JobLocationStore,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._session = session
        self._config = config
        self._jobs = JobCancellations(session, ProService(session), locations)
        self._cancellations = CancellationRepository(session)
        self._ledger = RefundLedger(session)
        # Only the row and the state are read and written here: the worker calls Stripe.
        self._refunds = CancelRefunds(session, None, timedelta(0), clock)
        self._requests = RequestStateMachine(session)
        self._request_reader = CustomerRequestReader(session)
        self._audit = AuditService(session)

    async def preview(self, user: UserAccount, job_id: uuid.UUID) -> CancelPreviewOut:
        """What cancelling the caller's job now would keep and give back. Writes nothing."""
        try:
            job = await self._own_job(user, job_id)
            if job.status not in CANCELLABLE:
                raise CancelNotAllowedError(job.status.value)
            payment = await self._payment(job)
            split = self._split(job, payment)
            return CancelPreviewOut(
                job_id=job.job_id,
                job_status=job.status,
                fee_applies=job.status is JobStatus.ON_THE_WAY,
                fee_bps=self._config.fee_bps,
                customer_total_cents=payment.customer_total_cents,
                fee_cents=split.fee_cents,
                refund_cents=split.refund_cents,
                currency=payment.currency,
            )
        finally:
            await self._session.rollback()

    async def cancel_as_customer(
        self,
        user: UserAccount,
        job_id: uuid.UUID,
        data: CustomerCancelIn,
        queue: JobQueue,
        idempotency_key: uuid.UUID | None = None,
    ) -> tuple[CancellationOut, bool]:
        """The customer cancels their job (see the module doc), and whether it was cancelled
        now (False: an earlier cancel, returned as it is). Ends every transaction it opens."""
        ask = _Ask(
            party=CancelParty.CUSTOMER,
            reason=CancelReason(data.reason_code.value),
            note=_clean(data.note),
            idempotency=_keyed(idempotency_key, data),
            expected_fee_cents=data.expected_fee_cents,
        )
        job_id, created = await self._cancel(user, job_id, ask, queue)
        return await self.view(job_id), created

    async def cancel_as_pro(
        self,
        user: UserAccount,
        job_id: uuid.UUID,
        data: ProCancelIn,
        queue: JobQueue,
        idempotency_key: uuid.UUID | None = None,
    ) -> tuple[ProCancellationOut, bool]:
        """The pro cancels their job (see the module doc): the customer gets everything back,
        the request closes. Whether it was cancelled now (False: an earlier cancel, by either
        side, returned as it is). Ends every transaction it opens."""
        ask = _Ask(
            party=CancelParty.PRO,
            reason=CancelReason(data.reason_code.value),
            note=_clean(data.note),
            idempotency=_keyed(idempotency_key, data),
        )
        job_id, created = await self._cancel(user, job_id, ask, queue)
        return await self.pro_view(job_id), created

    async def _cancel(
        self, user: UserAccount, job_id: uuid.UUID, ask: _Ask, queue: JobQueue
    ) -> tuple[uuid.UUID, bool]:
        """The cancel both sides make: (the job's id, cancelled now). See the module doc."""
        idempotency = ask.idempotency
        try:
            # The caller's own job first, unlocked: nobody else's job row is ever locked here.
            await self._own_job(user, job_id, ask.party)
            job = await self._jobs.locked(job_id)
            if job is None:  # pragma: no cover - jobs are never deleted
                raise NotFoundError
            if idempotency is not None:
                keyed = await self._cancellations.by_idempotency_key(user.id, idempotency.key)
                if keyed is not None and (
                    keyed.job_id != job.job_id
                    or not same_body(keyed.idempotency_fingerprint, idempotency.fingerprint)
                ):
                    logger.info("cancel_idempotency_key_reused", extra={"job_id": str(job_id)})
                    raise IdempotencyKeyReusedError
            if await self._cancellations.of_job(job.job_id) is not None:
                await self._replay(job.job_id, queue)
                return job.job_id, False
            cancelled_from = CANCELLABLE.get(job.status)
            if cancelled_from is None:
                raise CancelNotAllowedError(job.status.value)
            payment = await self._payment(job)
            if await self._ledger.job_has_transfer(job.job_id):
                logger.error("cancel_job_has_transfer", extra={"job_id": str(job.job_id)})
                raise CancelNeedsReviewError
            fee_bps = self._fee_bps(job, ask.party)
            split = self._split(job, payment, ask.party)
            if ask.expected_fee_cents is not None and ask.expected_fee_cents != split.fee_cents:
                logger.info("cancel_fee_changed", extra={"job_id": str(job.job_id)})
                raise CancelFeeChangedError
            cancellation = JobCancellation(
                job_id=job.job_id,
                cancelled_by=user.id,
                party=ask.party,
                reason_code=ask.reason,
                note=ask.note,
                from_status=cancelled_from,
                fee_bps=fee_bps,
                fee_cents=split.fee_cents,
                refund_cents=split.refund_cents,
                idempotency_key=idempotency and idempotency.key,
                idempotency_fingerprint=idempotency and idempotency.fingerprint,
            )
            try:
                await self._cancellations.add(cancellation)
            except IntegrityError as error:
                await self._session.rollback()
                constraint = violated_constraint(error)
                if constraint == ONE_PER_JOB:  # pragma: no cover - under the job's lock
                    await self._replay(job.job_id, queue)
                    return job.job_id, False
                if constraint == IDEMPOTENCY_KEY_INDEX:
                    # A cancel of another job took this key after the check above.
                    raise IdempotencyKeyReusedError from None
                raise
            refund_id = None
            if split.refund_cents > 0:
                refund_id = await self._refunds.add_intent(job.job_id, payment, split.refund_cents)
            await self._jobs.cancelled(job.job_id, user)
            await self._close_request(job, user if ask.party is CancelParty.CUSTOMER else None)
            await self._audit.record_party_action(
                user.id,
                AuditAction.JOB_CANCEL,
                AuditEntity(AuditEntityType.JOB, job.job_id),
                {"status": job.status.value},
                {
                    "status": JobStatus.CANCELLED.value,
                    "cancelled_by": ask.party.value,
                    "reason_code": cancellation.reason_code.value,
                    "fee_bps": fee_bps,
                    "fee_cents": split.fee_cents,
                    "refund_cents": split.refund_cents,
                    "customer_total_cents": payment.customer_total_cents,
                    "refund_id": None if refund_id is None else str(refund_id),
                },
            )
            public_code = await self._request_reader.public_code(job.request_id)
            await self._session.commit()
        finally:
            await self._session.rollback()
        logger.info(
            "job_cancelled",
            extra={
                "job_id": str(job.job_id),
                "pro_id": str(job.pro_id),
                "cancelled_by": ask.party.value,
                "from_status": cancelled_from.value,
                "fee_cents": split.fee_cents,
                "refund_cents": split.refund_cents,
            },
        )
        await self._after_commit(
            job, public_code, ask.party, refund=split.refund_cents > 0, queue=queue
        )
        return job.job_id, True

    async def view(self, job_id: uuid.UUID) -> CancellationOut:
        """The job's cancellation as last committed. Ends its transaction."""
        try:
            cancellation = await self._cancellations.of_job(job_id)
            if cancellation is None:  # pragma: no cover - read after it was committed
                raise NotFoundError
            job = await self._jobs.read(job_id)
            payment = None if job is None else await self._ledger.payment_of_quote(job.quote_id)
            if payment is None:  # pragma: no cover - the cancellation was made from it
                raise NotFoundError
            refund = await self._refunds.of_job(job_id)
            return CancellationOut(
                job_id=cancellation.job_id,
                job_status=JobStatus.CANCELLED,
                cancelled_by=cancellation.party,
                reason_code=cancellation.reason_code,
                fee_cents=cancellation.fee_cents,
                refund_cents=cancellation.refund_cents,
                currency=payment.currency,
                refund_status=CancelRefundState.NONE if refund is None else refund.state,
                cancelled_at=cancellation.created_at,
            )
        finally:
            await self._session.rollback()

    async def pro_view(self, job_id: uuid.UUID) -> ProCancellationOut:
        """The job's cancellation as its pro reads it: who, why and when, never the money or
        the note. Ends its transaction."""
        try:
            cancellation = await self._cancellations.of_job(job_id)
            if cancellation is None:  # pragma: no cover - read after it was committed
                raise NotFoundError
            return ProCancellationOut(
                job_id=cancellation.job_id,
                job_status=JobStatus.CANCELLED,
                cancelled_by=cancellation.party,
                reason_code=cancellation.reason_code,
                cancelled_at=cancellation.created_at,
            )
        finally:
            await self._session.rollback()

    async def _replay(self, job_id: uuid.UUID, queue: JobQueue) -> None:
        """A cancel of a cancelled job: nothing written. Its refund, while not settled, is
        queued again (the worker skips one under way)."""
        await self._session.rollback()
        out = await self.view(job_id)
        if out.refund_status is CancelRefundState.PENDING:
            await enqueue_cancel_refund(queue, job_id, self._config.enqueue_timeout_seconds)

    async def _own_job(
        self, user: UserAccount, job_id: uuid.UUID, party: CancelParty = CancelParty.CUSTOMER
    ) -> JobCancelFacts:
        """The caller's job on the side they cancel from; the same 404 for anyone else's."""
        job = await self._jobs.of_party(user.id, job_id)
        if job is None:
            raise NotFoundError
        side = job.customer_id if party is CancelParty.CUSTOMER else job.pro_user_id
        if side != user.id:
            raise NotFoundError
        return job

    async def _payment(self, job: JobCancelFacts) -> PaymentFacts:
        """The job's succeeded payment, checked against the job's frozen amounts."""
        payment = await self._ledger.payment_of_quote(job.quote_id)
        if (
            payment is None
            or payment.payment_intent_id is None
            or payment.amount_cents != job.customer_price_cents
            or payment.pro_payout_cents != job.pro_payout_cents
            or not 0 < payment.amount_cents <= payment.customer_total_cents
        ):
            logger.error("cancel_payment_mismatch", extra={"job_id": str(job.job_id)})
            raise CancelNeedsReviewError
        return payment

    def _fee_bps(self, job: JobCancelFacts, party: CancelParty = CancelParty.CUSTOMER) -> int:
        """The customer's: free before the pro's On my way, the setting's rate after it. A pro's
        cancel never charges the customer."""
        if party is CancelParty.PRO:
            return 0
        return self._config.fee_bps if job.status is JobStatus.ON_THE_WAY else 0

    def _split(
        self,
        job: JobCancelFacts,
        payment: PaymentFacts,
        party: CancelParty = CancelParty.CUSTOMER,
    ) -> CancellationSplit:
        return cancellation_split(
            payment.customer_total_cents, payment.amount_cents, self._fee_bps(job, party)
        )

    async def _close_request(self, job: JobCancelFacts, customer: UserAccount | None) -> None:
        """accepted -> cancelled: the customer as actor after their own cancel, the system
        after the pro's (pros never move a request). Never reopened. A request in any other
        status is left as it is (logged): the job's cancel stands on its own."""
        request = await self._requests.lock(job.request_id)
        status = None if request is None else request.status
        if status is not RequestStatus.ACCEPTED:
            logger.warning(
                "cancel_request_not_accepted",
                extra={"job_id": str(job.job_id), "request_status": str(status)},
            )
            return
        actor = SYSTEM if customer is None else customer
        await self._requests.transition(job.request_id, RequestStatus.CANCELLED, actor)

    async def _after_commit(
        self,
        job: JobCancelFacts,
        public_code: str,
        party: CancelParty,
        *,
        refund: bool,
        queue: JobQueue,
    ) -> None:
        timeout = self._config.enqueue_timeout_seconds
        if refund:
            await enqueue_cancel_refund(queue, job.job_id, timeout)
        if party is CancelParty.PRO:
            await push_job_cancelled_by_pro(
                queue,
                customer_id=job.customer_id,
                job_id=job.job_id,
                request_id=job.request_id,
                public_code=public_code,
                timeout_seconds=timeout,
            )
            return
        await push_job_cancelled_by_customer(
            queue,
            pro_user_id=job.pro_user_id,
            job_id=job.job_id,
            public_code=public_code,
            timeout_seconds=timeout,
        )
        await push_job_cancelled(
            queue,
            customer_id=job.customer_id,
            job_id=job.job_id,
            request_id=job.request_id,
            public_code=public_code,
            timeout_seconds=timeout,
        )


def _keyed(key: uuid.UUID | None, data: CustomerCancelIn | ProCancelIn) -> _Idempotency | None:
    """The cancel's Idempotency-Key with the fingerprint of the body it came with."""
    return None if key is None else _Idempotency(key=key, fingerprint=body_fingerprint(data))


def _clean(note: str | None) -> str | None:
    """The note as stored: contact details masked, trimmed; 422 when nothing is left (only
    invisible characters) or, in theory, masks run it past the limit."""
    if note is None:
        return None
    cleaned = redact_contacts(note).text.strip()
    if not cleaned or len(cleaned) > NOTE_MAX_LENGTH:
        raise InvalidCancelInputError
    return cleaned
