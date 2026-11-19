"""Staff repair of a dispute whose refund Stripe refused for good (#434; #450 round 1).

A dispute's refund row fixes its decision (refund_already_attempted): Stripe may hold the
refund, so another decision could pay twice. The repair is for one situation: Stripe's answer
is final and no refund of the payment can still move money. Then `abandon` gives that refund
up: the row becomes abandoned (kept, with its attempts and Stripe's ids), its audit row names
the operator, and an admin may decide the dispute again; a refund then takes a new row and key
(payments.refunds). Run through scripts/resolve_dispute_refund.py; there is no HTTP endpoint.
Off unless REFUND_ABANDON_ENABLED: the release that reads an abandoned refund must have
replaced the previous one on the api and the worker first.

The refund may be abandoned only when one of these holds:
- its last attempt failed with Stripe's definitive answer to the create (a 4xx error with a
  Stripe code, stored as last_error_definitive): Stripe answers the same key with the same
  refusal, so that create can never make a refund;
- Stripe accepted it and has since failed or canceled it (a terminal status), as Stripe says
  NOW: the apply reads it again by its id and requires that, never trusting the stored one.
Anything uncertain is refused, and settled by the same decision instead (its retry reads Stripe
and adopts a refund a lost answer made, #76): an attempt with no outcome, however old (age is
no proof that a request ended), a call that timed out or failed on Stripe's side, a listing that
could not be matched, a refund Stripe holds that is not terminal.

And Stripe must show no refund of the payment that could still move money: every refund of the
PaymentIntent, ours or not (one made in the dashboard, another dispute's), listed in full,
must be failed or canceled. A listing with further pages, or one Stripe cannot give, refuses.

`apply` False checks only (the script's first look, before the operator confirms): it writes
nothing. Applied, Stripe is read again, then everything above is checked again under the job's
lock, the dispute's and the row's (the row must be as the read saw it), and the row is abandoned
with its audit row (AuditService.record: an active admin, the money path) in one transaction. A
confirmed attempt that is refused, or cannot finish (Stripe unavailable), writes an audit row
of its outcome (dispute.refund_abandon_refused: a fixed code, no provider text) before the
refusal is answered. No lock or transaction is held across a Stripe call. Logs carry ids only.
"""

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import NotFoundError
from app.integrations.stripe_errors import StripeCallError
from app.integrations.stripe_refunds import StripeRefunds
from app.modules.audit.service import AuditService
from app.modules.audit.types import AuditAction, AuditEntity, AuditEntityType, AuditState, Operator
from app.modules.disputes.errors import DisputeNeedsReviewError, RefundRepairRefusedError
from app.modules.disputes.models import DisputeStatus
from app.modules.disputes.resolution import RefundSettlement
from app.modules.payments.errors import PaymentsNotConfiguredError
from app.modules.payments.refunds import DisputeRefund, RefundLedger, made_for

logger = logging.getLogger(__name__)

RETRY_THE_DECISION = (
    "send the same decision again: its retry reads Stripe and settles what Stripe made"
)


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
        "last_error_definitive": refund.last_error_definitive,
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
        *,
        enabled: bool,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._session = session
        self._stripe = stripe
        self._enabled = enabled
        self._settlement = RefundSettlement(session, clock)
        self._ledger = RefundLedger(session)
        self._audit = AuditService(session)

    async def abandon(self, dispute_id: uuid.UUID, operator: Operator, *, apply: bool) -> None:
        """Gives the dispute's refund up (see the module doc). Ends every transaction it opens;
        RefundRepairRefusedError on a refusal, PaymentsNotConfiguredError without Stripe,
        StripeCallError when Stripe cannot be read. Applied, a refusal is audited first."""
        refund_id: uuid.UUID | None = None
        try:
            if not self._enabled:
                raise RefundRepairRefusedError(
                    "disabled",
                    "Refund repair is off (REFUND_ABANDON_ENABLED). It is turned on only once "
                    "the deploy that reads abandoned refunds has finished on the api and the "
                    "worker; nothing changed.",
                )
            if self._stripe is None:
                raise PaymentsNotConfiguredError
            seen = await self._target(dispute_id)
            refund_id = seen.refund.refund_id
            # The locks end before Stripe is read.
            await self._session.rollback()
            await self._stripe_allows(self._stripe, dispute_id, seen)
            if not apply:
                return
            target = await self._target(dispute_id)
            if target.refund != seen.refund:
                raise RefundRepairRefusedError(
                    "row_changed",
                    "The refund changed while Stripe was read; nothing changed. Run it again.",
                )
            if not await self._ledger.abandon(target.refund):  # pragma: no cover - row locked
                raise RefundRepairRefusedError("abandoned_already", "Abandoned already.")
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
        except (RefundRepairRefusedError, StripeCallError, PaymentsNotConfiguredError) as error:
            await self._session.rollback()
            if apply:
                await self._audit_refusal(dispute_id, operator, refund_id, error)
            raise
        finally:
            await self._session.rollback()

    async def _audit_refusal(
        self,
        dispute_id: uuid.UUID,
        operator: Operator,
        refund_id: uuid.UUID | None,
        error: Exception,
    ) -> None:
        """A confirmed attempt that did not abandon: its outcome code on record (no provider
        text), committed before the refusal is answered."""
        if isinstance(error, RefundRepairRefusedError):
            outcome = error.code
        elif isinstance(error, PaymentsNotConfiguredError):
            outcome = "stripe_not_configured"
        else:
            outcome = "stripe_unavailable"
        await self._audit.record(
            operator,
            AuditAction.DISPUTE_REFUND_ABANDON_REFUSED,
            AuditEntity(AuditEntityType.DISPUTE, dispute_id),
            {},
            {"outcome": outcome, "refund_id": None if refund_id is None else str(refund_id)},
        )
        await self._session.commit()
        logger.warning(
            "dispute_refund_abandon_refused",
            extra={"dispute_id": str(dispute_id), "outcome": outcome},
        )

    async def _target(self, dispute_id: uuid.UUID) -> _Target:
        """Under the job's lock, the dispute's and the refund row's: the refund that may be
        abandoned by its row, or a refusal."""
        try:
            locked = await self._settlement.lock(dispute_id)
        except NotFoundError:
            raise RefundRepairRefusedError(
                "no_dispute", "No dispute has this id; nothing changed."
            ) from None
        except DisputeNeedsReviewError:
            raise RefundRepairRefusedError(
                "payment_mismatch",
                "The job's payment does not match the job (missing, or other frozen amounts): "
                "this script does not repair that; nothing changed.",
            ) from None
        if locked.dispute.status is DisputeStatus.RESOLVED:
            raise RefundRepairRefusedError(
                "dispute_resolved", "This dispute is resolved: its decision is final."
            )
        refund = await self._ledger.locked_of_dispute(dispute_id)
        if refund is None:
            raise RefundRepairRefusedError(
                "no_refund",
                "This dispute has no refund to abandon (none was attempted, or it was abandoned "
                "already): an admin can decide it now; nothing changed.",
            )
        if not (refund.refused_for_good or refund.created_then_dead):
            raise RefundRepairRefusedError(
                "not_final",
                "Stripe's answer for this refund is not final (an attempt with no outcome, a "
                "call that timed out or failed on Stripe's side, Stripe records not matched, or "
                f"a refund Stripe holds that may still go through): {RETRY_THE_DECISION}; "
                "nothing changed.",
            )
        if locked.payment.payment_intent_id is None:  # pragma: no cover - lock() checks it
            raise RefundRepairRefusedError("payment_mismatch", "The payment has no intent.")
        return _Target(refund=refund, payment_intent_id=locked.payment.payment_intent_id)

    async def _stripe_allows(
        self, stripe: StripeRefunds, dispute_id: uuid.UUID, target: _Target
    ) -> None:
        """Stripe, read now: a refund Stripe accepted is terminal, and every refund of the
        PaymentIntent is failed or canceled; a refusal otherwise."""
        stored = target.refund.stripe_refund_id
        if stored is not None:
            read = await stripe.retrieve_refund(stored)
            if read.refund_id != stored or not read.dead:
                raise RefundRepairRefusedError(
                    "refund_not_terminal",
                    "Stripe does not show this refund failed or canceled now: "
                    f"{RETRY_THE_DECISION}; nothing changed.",
                )
        found = await stripe.list_refunds(target.payment_intent_id)
        if not found.complete:
            raise RefundRepairRefusedError(
                "listing_incomplete",
                "Stripe lists more refunds for this payment than one page: reconcile them in "
                "the dashboard first; nothing changed.",
            )
        for fact in found.refunds:
            if fact.dead:
                continue
            ours = fact.dispute_id == str(dispute_id) or made_for(
                fact, dispute_id, target.refund.idempotency_key
            )
            if ours:
                raise RefundRepairRefusedError(
                    "refused_live_refund",
                    "Stripe shows a refund for this dispute that is not failed or canceled: "
                    f"{RETRY_THE_DECISION}; nothing changed.",
                )
            raise RefundRepairRefusedError(
                "refused_unattributed_refund",
                "A refund exists on this payment that this dispute did not create; reconcile in "
                "Stripe first; nothing changed.",
            )
        if stored is not None and stored not in {fact.refund_id for fact in found.refunds}:
            raise RefundRepairRefusedError(
                "refund_not_listed",
                "Stripe does not list the refund this dispute's row holds: look in the "
                "dashboard; nothing changed.",
            )
