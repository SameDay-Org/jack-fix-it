"""Worker side of payments (#297): the cron that closes payments left unpaid.

A customer who accepts a quote and never pays leaves the request accepted and the quote held:
Stripe never cancels an unconfirmed PaymentIntent on its own. So a run takes one `now` and reads
the payments still unpaid (requires_payment or failed; never processing) created more than
PAYMENT_UNPAID_CANCEL_AFTER_SECONDS before it, in batches of UNPAID_BATCH, by id, so each comes
up once per run. Each payment is then checked in a transaction of its own
(PaymentReconciler.close_unpaid: locks request -> quote -> payment, and the status, the age and
the request read again under them), which also cancels a payment that never had a PaymentIntent
and reopens its quote. A payment with a PaymentIntent is canceled in Stripe after that
transaction ends, so no lock is held over the network call, with a deterministic idempotency
key; the payment_intent.canceled event that follows reopens the quote (#61), one path for every
canceled intent. Until it arrives the payment stays unpaid, and the next run sends the same
cancel again (Stripe replays it). Stripe refusing the cancel because the intent is processing,
succeeded or canceled already (the customer paid meanwhile) changes nothing; Stripe unavailable
or refusing otherwise is logged by error class and code, and the next run tries again. A payment
whose PaymentIntent create was attempted with no answer stored is left to #296, the payment
call's search and staff: the cron never creates or searches.

A payment that fails is rolled back and logged, and the run goes on with the next one; a batch
that cannot be read ends the run. Nothing raises out of the cron. Logs carry ids, counts,
outcomes and Stripe's error codes only: no PaymentIntent id, amount or customer data. One
`unpaid_payments_swept` summary per run, even when the run is cut short.
"""

import logging
import uuid
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.stripe_errors import StripeCallError
from app.integrations.stripe_payments import StripePayments
from app.modules.payments.reconciliation import PaymentReconciler, UnpaidCheck, UnpaidOutcome
from app.modules.payments.repository import PaymentRepository
from app.modules.payments.service import payment_intent_cancel_idempotency_key

logger = logging.getLogger(__name__)

# Payments read per query; each is then checked in its own transaction.
UNPAID_BATCH: Final = 200

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


@dataclass
class _Counts:
    canceled_remote: int = 0
    canceled_local: int = 0
    skipped: int = 0
    unresolved: int = 0
    failed: int = 0


async def cancel_unpaid_payments(ctx: dict[str, Any]) -> None:
    """ARQ cron: closes the payments left unpaid past the window (see the module doc)."""
    sessions: SessionFactory = ctx["session_factory"]
    settings: Settings = ctx["settings"]
    stripe: StripePayments | None = ctx.get("stripe_payments")
    created_before = datetime.now(UTC) - timedelta(
        seconds=settings.payment_unpaid_cancel_after_seconds
    )
    counts = _Counts()
    after: uuid.UUID | None = None
    try:
        while True:
            try:
                async with sessions() as session:
                    due = await PaymentRepository(session).unpaid_due(
                        created_before, after, UNPAID_BATCH
                    )
            # A batch that cannot be read, whatever the reason, ends the run; the next run
            # reads it again. By class only: a database error's text can hold SQL literals.
            except Exception as error:  # noqa: BLE001
                logger.error("unpaid_payments_unavailable", extra={"error": type(error).__name__})
                return
            for payment_id in due:
                await _close_one(sessions, stripe, payment_id, created_before, counts)
            if len(due) < UNPAID_BATCH:
                return
            after = due[-1]
    finally:
        logger.info(
            "unpaid_payments_swept",
            extra={
                "canceled_remote": counts.canceled_remote,
                "canceled_local": counts.canceled_local,
                "skipped": counts.skipped,
                "unresolved": counts.unresolved,
                "failed": counts.failed,
            },
        )


async def _close_one(
    sessions: SessionFactory,
    stripe: StripePayments | None,
    payment_id: uuid.UUID,
    created_before: datetime,
    counts: _Counts,
) -> None:
    """One payment: checked (and canceled locally) in its own transaction, then canceled in
    Stripe when it holds a PaymentIntent. Counted once; never raises."""
    try:
        async with sessions() as session:
            check = await PaymentReconciler(session).close_unpaid(payment_id, created_before)
            await session.commit()
    # One payment's failure, whatever it is, never stops the others; the next run tries it
    # again. By class only: a database error's text can hold SQL literals.
    except Exception as error:  # noqa: BLE001
        counts.failed += 1
        logger.error(
            "payment_unpaid_cancel_failed",
            extra={"payment_id": str(payment_id), "error": type(error).__name__},
        )
        return
    match check.outcome:
        case UnpaidOutcome.CANCELED_LOCALLY:
            counts.canceled_local += 1
        case UnpaidOutcome.NOT_DUE:
            counts.skipped += 1
            logger.debug("payment_unpaid_not_due", extra={"payment_id": str(payment_id)})
        case UnpaidOutcome.UNRESOLVED:
            counts.unresolved += 1
            logger.warning("payment_unpaid_unresolved", extra=check.ids)
        case UnpaidOutcome.CANCEL_IN_STRIPE:
            await _cancel_in_stripe(stripe, payment_id, check, counts)


async def _cancel_in_stripe(
    stripe: StripePayments | None, payment_id: uuid.UUID, check: UnpaidCheck, counts: _Counts
) -> None:
    """Asks Stripe to cancel the payment's PaymentIntent; its canceled event reopens the quote."""
    if stripe is None or check.intent_id is None:
        counts.failed += 1
        logger.error("payment_unpaid_stripe_not_configured", extra=check.ids)
        return
    try:
        canceled = await stripe.cancel_payment_intent(
            check.intent_id, idempotency_key=payment_intent_cancel_idempotency_key(payment_id)
        )
    except StripeCallError as error:
        counts.failed += 1
        logger.error(
            "payment_unpaid_cancel_failed",
            extra={**check.ids, "error": type(error).__name__, "stripe_code": error.code},
        )
        return
    # Anything else (a bug) is logged by class, never with its text, and the run goes on.
    except Exception as error:  # noqa: BLE001
        counts.failed += 1
        logger.error(
            "payment_unpaid_cancel_failed", extra={**check.ids, "error": type(error).__name__}
        )
        return
    if canceled:
        counts.canceled_remote += 1
        logger.info("payment_unpaid_cancel_requested", extra=check.ids)
    else:
        # Processing, succeeded or canceled in Stripe: its own event settles the payment.
        counts.skipped += 1
        logger.debug("payment_unpaid_not_cancelable", extra=check.ids)
