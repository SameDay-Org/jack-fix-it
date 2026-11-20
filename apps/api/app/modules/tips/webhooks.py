"""The payment_intent.* events of a tip's PaymentIntent (#273): metadata kind "tip".

The webhook registry (webhooks/handlers.py) routes an event here by that kind, so a tip never
reaches the job payment's reconciliation, and a job payment's event never reaches a tip. Run
by the worker through the Stripe webhook base (#40): once per event, in the worker's
transaction, which a handler never commits.

The event finds the tip whose current attempt is its PaymentIntent, locked. A tip whose create
answer was lost holds no PaymentIntent yet: when the event's metadata names that tip and its
current attempt (tip_id, attempt), and the tip is still to pay with a create sent, the event's
intent is stored (a conditional UPDATE in a savepoint) and the event applied, as the payment's
reconciliation adopts one (#296). An intent of an earlier attempt changes nothing: the tip
moved to a new attempt only once Stripe showed that intent canceled (service.py). One that
succeeded anyway took money no tip holds: an ERROR `tip_succeeded_on_stale_attempt` (ids) and
the event fails for staff. An intent naming no tip is a warning and changes nothing.

Then, before anything else, the event must match the tip: its amount the tip's amount_cents,
its currency the tip's, its customer the customer's Stripe Customer. A mismatch changes
nothing, logs `tip_event_mismatch` (ids and the names of the fields that differ) and raises,
so the event is retried and then ends failed for staff.

The tip's status then moves along TIP_EVENT_TRANSITIONS: processing, failed (the same intent
can be confirmed again), succeeded (with succeeded_at, and a `tip_added` line in the job's
history, the customer its actor) or canceled. Anything else (a repeat, an out-of-order event,
anything after succeeded or canceled) changes nothing, at debug level. Nothing here changes
the job's status, its payment or its transfer. A tip that succeeded queues its receipt email
once the event commits (#62): once, since a repeat of the event moves nothing. Logs carry ids,
the event type, statuses and Stripe codes only: no amount, no PaymentIntent id, no customer
data.
"""

import logging
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from functools import partial
from types import MappingProxyType
from typing import Final

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.service import JobTimeline
from app.modules.payments.webhook_handlers import intent_event
from app.modules.receipts.queue import enqueue_tip_receipt
from app.modules.tips.errors import TipEventMismatchError, TipRowMissingError
from app.modules.tips.models import UNPAID_STATUSES, Tip, TipStatus
from app.modules.tips.repository import TipRepository
from app.modules.users.service import UserService
from app.modules.webhooks.events import AfterCommit, StripeEvent, StripeEventHandler
from app.queue import JobQueue

logger = logging.getLogger(__name__)

_S = TipStatus
# (from, to) along the tip's PaymentIntent events. Anything not listed changes nothing.
TIP_EVENT_TRANSITIONS: Final = frozenset(
    {
        (_S.REQUIRES_PAYMENT, _S.PROCESSING),
        (_S.REQUIRES_PAYMENT, _S.FAILED),
        (_S.REQUIRES_PAYMENT, _S.SUCCEEDED),
        (_S.REQUIRES_PAYMENT, _S.CANCELED),
        (_S.PROCESSING, _S.SUCCEEDED),
        (_S.PROCESSING, _S.FAILED),
        (_S.PROCESSING, _S.CANCELED),
        (_S.FAILED, _S.PROCESSING),
        (_S.FAILED, _S.SUCCEEDED),
        (_S.FAILED, _S.CANCELED),
    }
)


@dataclass(frozen=True)
class TipIntentEvent:
    """A tip's payment_intent.* event as the reconciliation reads it."""

    stripe_event_id: str
    event_type: str
    intent_id: str
    amount: int
    currency: str
    customer: str | None
    failure_code: str | None
    # The metadata the tip's create writes (strings): read only to adopt a lost create's
    # intent. Never logged.
    tip_id: str | None
    attempt: str | None


def tip_intent_event(event: StripeEvent) -> TipIntentEvent:
    """The event's PaymentIntent; malformed as for a payment's (logged and raised)."""
    base = intent_event(event)
    data = event.payload.get("data")
    intent = data.get("object") if isinstance(data, Mapping) else None
    metadata = intent.get("metadata") if isinstance(intent, Mapping) else None
    named = metadata.get("tip_id") if isinstance(metadata, Mapping) else None
    attempt = metadata.get("attempt") if isinstance(metadata, Mapping) else None
    return TipIntentEvent(
        stripe_event_id=base.stripe_event_id,
        event_type=base.event_type,
        intent_id=base.intent_id,
        amount=base.amount,
        currency=base.currency,
        customer=base.customer,
        failure_code=base.failure_code,
        tip_id=named if isinstance(named, str) else None,
        attempt=attempt if isinstance(attempt, str) else None,
    )


def _ids(event: TipIntentEvent, tip: Tip) -> dict[str, str]:
    return {
        "tip_id": str(tip.id),
        "job_id": str(tip.job_id),
        "stripe_event_id": event.stripe_event_id,
        "event_type": event.event_type,
    }


def _named_tip(value: str | None) -> uuid.UUID | None:
    """The tip id the metadata names, as the tip's create writes it (a lowercase UUID with
    hyphens); None for anything else."""
    if value is None:
        return None
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        return None
    return parsed if str(parsed) == value else None


class TipReconciler:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._tips = TipRepository(session)
        self._users = UserService(session)
        self._timeline = JobTimeline(session)

    async def apply(self, event: TipIntentEvent, status: TipStatus) -> uuid.UUID | None:
        """Applies the event; returns the tip's id when it succeeded through this event (its
        receipt is then queued after the commit), else None."""
        tip = await self._tips.get_by_intent_for_update(event.intent_id)
        if tip is None:
            tip = await self._adopt(event, status)
            if tip is None:
                return None
        else:
            await self._check(event, tip)
        current = tip.status
        if (current, status) not in TIP_EVENT_TRANSITIONS:
            logger.debug("tip_event_ignored", extra={**_ids(event, tip), "tip_status": current})
            return None
        if not await self._tips.move_status(tip.id, event.intent_id, current, status):
            raise TipRowMissingError  # pragma: no cover - the row is locked
        ids = _ids(event, tip)
        if status is TipStatus.SUCCEEDED:
            await self._timeline.tip_added(tip.job_id, tip.customer_id)
            logger.info("tip_succeeded", extra=ids)
            return tip.id
        if status is TipStatus.FAILED:
            logger.info("tip_payment_failed", extra={**ids, "stripe_code": event.failure_code})
        else:
            logger.info("tip_status_moved", extra={**ids, "tip_status": status.value})
        return None

    async def _adopt(self, event: TipIntentEvent, status: TipStatus) -> Tip | None:
        """The tip the metadata names, when the event's intent is its current attempt's lost
        create: stored on the locked row and returned. None (logged) otherwise."""
        tip_id = _named_tip(event.tip_id)
        tip = None if tip_id is None else await self._tips.get_for_update(tip_id)
        if tip is None:
            logger.warning(
                "tip_event_unknown_intent",
                extra={"stripe_event_id": event.stripe_event_id, "event_type": event.event_type},
            )
            return None
        current = (
            tip.stripe_payment_intent_id is None
            and tip.payment_intent_requested_at is not None
            and tip.status in UNPAID_STATUSES
            and event.attempt == str(tip.attempt)
        )
        if not current:
            if status is TipStatus.SUCCEEDED:
                logger.error("tip_succeeded_on_stale_attempt", extra=_ids(event, tip))
                raise TipEventMismatchError
            logger.info("tip_event_stale_attempt", extra=_ids(event, tip))
            return None
        await self._check(event, tip)
        try:
            async with self._session.begin_nested():
                stored = await self._tips.set_payment_intent_if_missing(
                    tip.id, tip.attempt, event.intent_id
                )
        except IntegrityError:
            # Another tip holds this intent (the unique column): nothing changes.
            stored = False
        if not stored:
            logger.warning("tip_event_not_adopted", extra=_ids(event, tip))
            return None
        logger.warning("tip_payment_intent_adopted_from_event", extra=_ids(event, tip))
        return tip

    async def _check(self, event: TipIntentEvent, tip: Tip) -> None:
        customer = await self._users.stripe_customer_id(tip.customer_id)
        differ = [
            name
            for name, same in (
                ("amount", event.amount == tip.amount_cents),
                ("currency", event.currency == tip.currency),
                ("customer", customer is not None and event.customer == customer),
            )
            if not same
        ]
        if differ:
            logger.error("tip_event_mismatch", extra={**_ids(event, tip), "fields": differ})
            raise TipEventMismatchError


async def _queue_receipt(tip_id: uuid.UUID, queue: JobQueue, timeout_seconds: float) -> None:
    await enqueue_tip_receipt(queue, tip_id, timeout_seconds)


def _moving_to(status: TipStatus) -> StripeEventHandler:
    async def handle(session: AsyncSession, event: StripeEvent, after_commit: AfterCommit) -> None:
        succeeded = await TipReconciler(session).apply(tip_intent_event(event), status)
        if succeeded is not None:
            after_commit.add(partial(_queue_receipt, succeeded))

    handle.__name__ = f"tip_intent_{status}"
    return handle


TIP_INTENT_HANDLERS: Final[Mapping[str, StripeEventHandler]] = MappingProxyType(
    {
        "payment_intent.processing": _moving_to(TipStatus.PROCESSING),
        "payment_intent.payment_failed": _moving_to(TipStatus.FAILED),
        "payment_intent.succeeded": _moving_to(TipStatus.SUCCEEDED),
        "payment_intent.canceled": _moving_to(TipStatus.CANCELED),
    }
)
