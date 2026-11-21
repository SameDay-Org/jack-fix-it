"""Worker side of tips (#273): the cron that cancels the PaymentIntents of tips left unpaid.

A customer who picks a tip and never pays leaves a PaymentIntent Stripe never cancels on its
own. So a run takes one `now` and reads the tips still unpaid (requires_payment or failed; never
processing) whose current PaymentIntent was asked for more than
PAYMENT_UNPAID_CANCEL_AFTER_SECONDS before it (the job payment's window and cadence, #297), in
batches of UNPAID_BATCH, by id. Each tip is locked and checked again in a transaction of its
own; its PaymentIntent is then canceled in Stripe after that transaction ends (no lock over the
call), under the key the choice's own cancel uses (versioned by the tip's updated_at). The
payment_intent.canceled event that follows marks the tip canceled (webhooks.py): one path for
every canceled intent, and the customer may tip again while the window is open. Stripe refusing
because the intent is processing, succeeded or canceled already changes nothing; Stripe
unavailable or refusing otherwise is logged by error class and code, and the next run tries
again. A tip whose create has no answer stored is not read: there is no intent to cancel.

A tip that fails is logged and the run goes on; a batch that cannot be read ends the run.
Nothing raises out of the cron. Logs carry ids, counts and Stripe's error codes only. One
`unpaid_tips_swept` summary per run, even when the run is cut short.
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
from app.modules.tips.intents import tip_cancel_idempotency_key
from app.modules.tips.models import UNPAID_STATUSES
from app.modules.tips.repository import TipRepository

logger = logging.getLogger(__name__)

# Tips read per query; each is then checked in its own transaction.
UNPAID_BATCH: Final = 200

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


@dataclass
class _Counts:
    canceled: int = 0
    skipped: int = 0
    failed: int = 0


@dataclass(frozen=True)
class _Due:
    """A tip to cancel, as read under its lock."""

    intent_id: str
    attempt: int
    version: datetime
    ids: dict[str, str]


async def cancel_unpaid_tips(ctx: dict[str, Any]) -> None:
    """ARQ cron: cancels the PaymentIntents of the tips left unpaid (see the module doc)."""
    sessions: SessionFactory = ctx["session_factory"]
    settings: Settings = ctx["settings"]
    stripe: StripePayments | None = ctx.get("stripe_payments")
    requested_before = datetime.now(UTC) - timedelta(
        seconds=settings.payment_unpaid_cancel_after_seconds
    )
    counts = _Counts()
    after: uuid.UUID | None = None
    try:
        while True:
            try:
                async with sessions() as session:
                    due = await TipRepository(session).unpaid_due(
                        requested_before, after, UNPAID_BATCH
                    )
            # A batch that cannot be read, whatever the reason, ends the run; the next run
            # reads it again. By class only: a database error's text can hold SQL literals.
            except Exception as error:  # noqa: BLE001
                logger.error("unpaid_tips_unavailable", extra={"error": type(error).__name__})
                return
            for tip_id in due:
                await _cancel_one(sessions, stripe, tip_id, requested_before, counts)
            if len(due) < UNPAID_BATCH:
                return
            after = due[-1]
    finally:
        logger.info(
            "unpaid_tips_swept",
            extra={"canceled": counts.canceled, "skipped": counts.skipped, "failed": counts.failed},
        )


async def _due(session: AsyncSession, tip_id: uuid.UUID, requested_before: datetime) -> _Due | None:
    """The tip, locked and checked again: still unpaid, with a PaymentIntent asked for before
    the cutoff. None otherwise."""
    tip = await TipRepository(session).get_for_update(tip_id)
    if (
        tip is None
        or tip.status not in UNPAID_STATUSES
        or tip.stripe_payment_intent_id is None
        or tip.payment_intent_requested_at is None
        or tip.payment_intent_requested_at >= requested_before
    ):
        return None
    return _Due(
        intent_id=tip.stripe_payment_intent_id,
        attempt=tip.attempt,
        version=tip.updated_at,
        ids={"tip_id": str(tip.id), "job_id": str(tip.job_id)},
    )


async def _cancel_one(
    sessions: SessionFactory,
    stripe: StripePayments | None,
    tip_id: uuid.UUID,
    requested_before: datetime,
    counts: _Counts,
) -> None:
    """One tip: checked in its own transaction, then its PaymentIntent canceled in Stripe.
    Counted once; never raises."""
    try:
        async with sessions() as session:
            due = await _due(session, tip_id, requested_before)
            await session.commit()
    # One tip's failure, whatever it is, never stops the others; the next run tries it again.
    # By class only: a database error's text can hold SQL literals.
    except Exception as error:  # noqa: BLE001
        counts.failed += 1
        logger.error(
            "tip_unpaid_cancel_failed",
            extra={"tip_id": str(tip_id), "error": type(error).__name__},
        )
        return
    if due is None:
        counts.skipped += 1
        logger.debug("tip_unpaid_not_due", extra={"tip_id": str(tip_id)})
        return
    if stripe is None:
        counts.failed += 1
        logger.error("tip_unpaid_stripe_not_configured", extra=due.ids)
        return
    try:
        canceled = await stripe.cancel_payment_intent(
            due.intent_id,
            idempotency_key=tip_cancel_idempotency_key(tip_id, due.attempt, due.version),
        )
    except StripeCallError as error:
        counts.failed += 1
        logger.error(
            "tip_unpaid_cancel_failed",
            extra={**due.ids, "error": type(error).__name__, "stripe_code": error.code},
        )
        return
    # Anything else (a bug) is logged by class, never with its text, and the run goes on.
    except Exception as error:  # noqa: BLE001
        counts.failed += 1
        logger.error("tip_unpaid_cancel_failed", extra={**due.ids, "error": type(error).__name__})
        return
    if canceled:
        counts.canceled += 1
        logger.info("tip_unpaid_cancel_requested", extra=due.ids)
    else:
        # Processing, succeeded or canceled in Stripe: its own event settles the tip.
        counts.skipped += 1
        logger.debug("tip_unpaid_not_cancelable", extra=due.ids)
