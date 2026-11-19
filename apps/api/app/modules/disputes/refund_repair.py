"""Staff repair of a dispute whose refund Stripe refused for good (#434; follow-up of #76).

A dispute's refund row fixes its decision (refund_already_attempted): Stripe may hold the
refund, so another decision could pay twice. When Stripe refused the refund for good (a
charge_disputed or charge_already_refunded answer, say), failed or canceled it, or holds refunds
its row cannot be matched with (refund_needs_review), nobody is paid and the dispute stays open.
Once staff looked at Stripe, `abandon` gives that refund up: the row becomes abandoned (kept,
with its attempts and Stripe's ids), its audit row names the operator, and an admin may decide
the dispute again. A refund then takes a new row and a new key (payments.refunds), so Stripe
never answers it with the abandoned one's stored answer. Run through
scripts/resolve_dispute_refund.py; there is no HTTP endpoint.

Refused, and nothing changes, unless every one of these holds:
- the dispute is open (a resolved decision is final) and its job's payment matches the job;
- it has a refund that is not abandoned;
- by its row, that refund cannot move money: no attempt under way (started less than
  REFUND_STUCK_PENDING_MINUTES ago with no outcome), and no Stripe refund that Stripe has not
  failed or canceled (pending, requires_action or succeeded: settle it with the same decision);
- Stripe agrees: the PaymentIntent's refunds, listed in full (the List API, not a search), hold
  none made for the dispute (metadata dispute_id, whatever its refund_key) that Stripe has not
  failed or canceled. Such a refund is canceled in the dashboard, or settled, first.

`apply` False checks only. Applied, Stripe is read again, then everything above is checked again
under the job's lock, the dispute's and the row's (the row must be as the read saw it), and the
row is abandoned with its audit row (AuditService.record: an active admin, the money path) in
one transaction. No lock or transaction is held across a Stripe call. Logs carry ids only.
"""

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import NotFoundError
from app.integrations.stripe_refunds import StripeRefunds
from app.modules.audit.service import AuditService
from app.modules.audit.types import AuditAction, AuditEntity, AuditEntityType, AuditState, Operator
from app.modules.disputes.errors import DisputeNeedsReviewError, RefundRepairRefusedError
from app.modules.disputes.models import DisputeStatus
from app.modules.disputes.resolution import RefundSettlement
from app.modules.payments.errors import PaymentsNotConfiguredError
from app.modules.payments.refunds import DisputeRefund, RefundLedger

logger = logging.getLogger(__name__)


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class _Target:
    """The refund to abandon and the PaymentIntent its refunds are listed under, as read under
    the locks (plain values)."""

    refund: DisputeRefund
    payment_intent_id: str


def _state(refund: DisputeRefund) -> AuditState:
    """The row as the audit row records it: ids, statuses, codes."""
    return {
        "refund_id": str(refund.refund_id),
        "job_id": str(refund.job_id),
        "status": refund.status.value,
        "stripe_refund_id": refund.stripe_refund_id,
        "stripe_status": refund.stripe_status,
        "last_error_code": refund.last_error_code,
        "attempts": refund.attempts,
        "idempotency_key": refund.idempotency_key,
        "customer_refund_cents": refund.amount_cents,
        "pro_release_cents": refund.pro_release_cents,
    }


class DisputeRefundRepair:
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
        self._settlement = RefundSettlement(session, clock)
        self._ledger = RefundLedger(session)
        self._audit = AuditService(session)

    async def abandon(self, dispute_id: uuid.UUID, operator: Operator, *, apply: bool) -> None:
        """Gives the dispute's refund up (see the module doc). Ends every transaction it opens;
        RefundRepairRefusedError on a refusal, PaymentsNotConfiguredError without Stripe."""
        try:
            if self._stripe is None:
                raise PaymentsNotConfiguredError
            seen = await self._target(dispute_id)
            # The locks end before Stripe is read.
            await self._session.rollback()
            await self._stripe_shows_none(self._stripe, dispute_id, seen)
            if not apply:
                return
            target = await self._target(dispute_id)
            if target.refund != seen.refund:
                raise RefundRepairRefusedError(
                    "The refund changed while Stripe was read; nothing changed. Run it again."
                )
            if not await self._ledger.abandon(target.refund):  # pragma: no cover - row locked
                raise RefundRepairRefusedError("The refund was abandoned already.")
            before = _state(target.refund)
            await self._audit.record(
                operator,
                AuditAction.DISPUTE_REFUND_ABANDON,
                AuditEntity(AuditEntityType.DISPUTE, dispute_id),
                before,
                {**before, "status": "abandoned"},
            )
            await self._session.commit()
            logger.warning(
                "dispute_refund_abandoned",
                extra={**target.refund.ids, "operator_id": str(operator.user_id)},
            )
        finally:
            await self._session.rollback()

    async def _target(self, dispute_id: uuid.UUID) -> _Target:
        """Under the job's lock, the dispute's and the refund row's: the refund that may be
        abandoned, or a refusal."""
        try:
            locked = await self._settlement.lock(dispute_id)
        except NotFoundError:
            raise RefundRepairRefusedError("No dispute has this id; nothing changed.") from None
        except DisputeNeedsReviewError:
            raise RefundRepairRefusedError(
                "The job's payment does not match the job (missing, or other frozen amounts): "
                "this script does not repair that; nothing changed."
            ) from None
        if locked.dispute.status is DisputeStatus.RESOLVED:
            raise RefundRepairRefusedError(
                "This dispute is resolved: its decision is final; nothing changed."
            )
        refund = await self._ledger.locked_of_dispute(dispute_id)
        if refund is None:
            raise RefundRepairRefusedError(
                "This dispute has no refund to abandon (none was attempted, or it was abandoned "
                "already): an admin can decide it now; nothing changed."
            )
        if refund.in_flight(self._clock(), self._stuck_after):
            raise RefundRepairRefusedError(
                "A refund attempt for this dispute is under way. Try again in a few minutes; "
                "nothing changed."
            )
        if refund.stripe_refund_id is not None and not refund.dead:
            raise RefundRepairRefusedError(
                f"Stripe holds this dispute's refund with status {refund.stripe_status!r}: it "
                "may still give the money back. Send the same decision again to settle it; "
                "nothing changed."
            )
        if locked.payment.payment_intent_id is None:  # pragma: no cover - lock() checks it
            raise RefundRepairRefusedError("The job's payment has no PaymentIntent.")
        return _Target(refund=refund, payment_intent_id=locked.payment.payment_intent_id)

    async def _stripe_shows_none(
        self, stripe: StripeRefunds, dispute_id: uuid.UUID, target: _Target
    ) -> None:
        """Stripe's own list of the PaymentIntent's refunds holds none made for the dispute
        that Stripe has not failed or canceled; a refusal otherwise."""
        found = await stripe.list_refunds(target.payment_intent_id)
        if not found.complete:
            raise RefundRepairRefusedError(
                "Stripe lists more refunds for this payment than one page: look in the "
                "dashboard; nothing changed."
            )
        ours = [fact for fact in found.refunds if fact.dispute_id == str(dispute_id)]
        if any(not fact.dead for fact in ours):
            raise RefundRepairRefusedError(
                "Stripe shows a refund for this dispute that is not failed or canceled: cancel "
                "it in the dashboard, or settle it with the same decision, first; nothing "
                "changed."
            )
        stored = target.refund.stripe_refund_id
        if stored is not None and stored not in {fact.refund_id for fact in ours}:
            raise RefundRepairRefusedError(
                "Stripe does not list the refund this dispute's row holds: look in the "
                "dashboard; nothing changed."
            )
