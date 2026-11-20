"""The payment_intent.* events of a tip's PaymentIntent (#273): metadata kind "tip".

The webhook registry (webhooks/handlers.py) routes an event here by that kind, so a tip never
reaches the job payment's reconciliation, and a job payment's event never reaches a tip. Run
by the worker through the Stripe webhook base (#40): once per event, in the worker's
transaction, which a handler never commits.

The event only names the PaymentIntent (#510 round 1): what it is, whose it is and where it
stands are read from Stripe by that id (StripePayments.tip_intent), never from the event's
copy, so an event that arrives late, twice or out of order ends at the state Stripe has now.
The four event types are handled alike:
1. The tip whose current attempt is this PaymentIntent is locked. When no tip holds it, the
   intent is read once to learn whose it is (its metadata tip_id), and that tip is locked.
2. Under the lock the intent is read (again): its kind, tip, job, attempt, customer and
   currency must be the locked tip's (and its amount the current attempt's). A mismatch
   changes nothing, logs `tip_event_mismatch` (ids and the names of the fields that differ)
   and raises, so the event ends failed for staff. Stripe failing, or no Stripe key: raised,
   so the worker rolls the handler back and runs the event again after its backoff.
3. Then, by what Stripe says:
   - the current attempt's intent: the tip's status moves to Stripe's current one along
     TIP_EVENT_TRANSITIONS (forward only: succeeded and canceled never move; anything else is
     a debug line). Succeeded stamps succeeded_at and adds a `tip_added` line to the job's
     history, the customer its actor;
   - the current attempt's lost create (no intent stored, a create sent): the intent is
     adopted (a conditional UPDATE in a savepoint), then as above;
   - an earlier attempt's intent: canceled before the tip moved on, so its events change
     nothing. One Stripe shows succeeded took money no attempt holds: the tip is flagged for
     staff (late_success_at, which also stops any new choice), its current attempt's intent is
     canceled when it still can be, and staff get an ERROR (`tip_succeeded_on_stale_attempt`)
     with the ids. Never a second silent charge.
   An intent naming no tip of ours is a warning and changes nothing.
Nothing here changes the job's status, its payment or its transfer. A tip that succeeded
through an event queues, once that event commits: its receipt email (#62), its transfer to the
pro (transfers.py, #273 PR A2) and the pro's tip_received push. Once, since a repeat moves
nothing (and a contained late success is staff's: no receipt, no transfer, no push). Logs
carry ids, the event type, statuses and Stripe codes only: no amount, no PaymentIntent id, no
customer data.
"""

import logging
import uuid
from collections.abc import Callable, Mapping
from functools import partial
from types import MappingProxyType
from typing import Final

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.stripe_errors import StripeCallError
from app.integrations.stripe_payments import (
    TIP_INTENT_KIND,
    StripePayments,
    TipIntentFacts,
    worker_stripe_payments,
)
from app.modules.jobs.service import JobTimeline
from app.modules.notifications.events import push_tip_received
from app.modules.payments.webhook_handlers import intent_event
from app.modules.pros.service import ProService
from app.modules.receipts.queue import enqueue_tip_receipt
from app.modules.requests.service import CustomerRequestReader
from app.modules.tips.errors import TipEventMismatchError, TipRowMissingError
from app.modules.tips.intents import (
    mismatches,
    named_tip,
    status_of,
    tip_cancel_idempotency_key,
)
from app.modules.tips.models import UNPAID_STATUSES, Tip, TipStatus
from app.modules.tips.repository import TipRepository
from app.modules.tips.transfer_queue import enqueue_tip_transfer
from app.modules.users.service import UserService
from app.modules.webhooks.events import AfterCommit, StripeEvent, StripeEventHandler
from app.queue import JobQueue

logger = logging.getLogger(__name__)

_S = TipStatus
# (from, to) along the tip's PaymentIntent, as Stripe reports it. Anything not listed changes
# nothing: succeeded and canceled are final.
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
TIP_EVENT_TYPES: Final = (
    "payment_intent.processing",
    "payment_intent.payment_failed",
    "payment_intent.succeeded",
    "payment_intent.canceled",
)

StripePaymentsProvider = Callable[[], StripePayments | None]


class TipsStripeNotConfiguredError(Exception):
    """No Stripe key: the PaymentIntent cannot be read, so the event is run again later."""


def _ids(ids: dict[str, str], tip: Tip) -> dict[str, str]:
    return {**ids, "tip_id": str(tip.id), "job_id": str(tip.job_id)}


class TipReconciler:
    def __init__(self, session: AsyncSession, stripe: StripePayments) -> None:
        self._session = session
        self._stripe = stripe
        self._tips = TipRepository(session)
        self._users = UserService(session)
        self._timeline = JobTimeline(session)

    async def apply(self, intent_id: str, ids: dict[str, str]) -> uuid.UUID | None:
        """Applies what Stripe says of the PaymentIntent (see the module doc). Returns the tip's
        id when it succeeded through this event, else None."""
        tip = await self._tips.get_by_intent_for_update(intent_id)
        if tip is None:
            first = await self._read(intent_id)
            tip_id = named_tip(first.tip_id) if first.kind == TIP_INTENT_KIND else None
            tip = None if tip_id is None else await self._tips.get_for_update(tip_id)
            if tip is None:
                logger.warning("tip_event_unknown_intent", extra=ids)
                return None
        facts = await self._read(intent_id)  # under the tip's lock: Stripe's state now
        current = facts.attempt == str(tip.attempt)
        holds = current and tip.stripe_payment_intent_id == intent_id
        adopting = (
            current
            and tip.stripe_payment_intent_id is None
            and tip.payment_intent_requested_at is not None
            and tip.status in UNPAID_STATUSES
        )
        # The amount is compared only while the tip holds the intent or adopts it for a lost
        # create: an intent of a closed attempt keeps the amount it was made with (#510 round
        # 2: an amount, then "No tip", keeps the attempt's number with 0 cents).
        await self._check(facts, tip, ids, amount=holds or adopting)
        if holds:
            return await self._settle(tip, facts, ids)
        if adopting:
            if not await self._adopt(tip, facts, ids):
                return None
            return await self._settle(tip, facts, ids)
        if not current or tip.status not in UNPAID_STATUSES:
            # A closed attempt's intent: an earlier attempt's, or this number's once nothing
            # of it is to pay ("No tip", canceled, paid by another intent).
            if facts.status == "succeeded":
                await self._contain(tip, ids)
            else:
                logger.info("tip_event_stale_attempt", extra=_ids(ids, tip))
            return None
        # The current attempt's number, but the tip holds another intent: not adopted.
        logger.warning("tip_event_not_adopted", extra=_ids(ids, tip))
        return None

    async def _read(self, intent_id: str) -> TipIntentFacts:
        # Stripe failing raises (StripeCallError): the event is rolled back and run again.
        return await self._stripe.tip_intent(intent_id)

    async def _check(
        self, facts: TipIntentFacts, tip: Tip, ids: dict[str, str], *, amount: bool
    ) -> None:
        """The intent is this locked tip's: its kind, tip, job, customer and currency, and,
        with `amount`, the current attempt's amount (an intent the tip holds or adopts)."""
        differ = mismatches(
            facts,
            tip_id=tip.id,
            job_id=tip.job_id,
            attempt=tip.attempt,
            amount_cents=tip.amount_cents if amount else None,
            currency=tip.currency,
            stripe_customer_id=await self._users.stripe_customer_id(tip.customer_id),
        )
        if differ:
            logger.error("tip_event_mismatch", extra={**_ids(ids, tip), "fields": differ})
            raise TipEventMismatchError

    async def _settle(
        self, tip: Tip, facts: TipIntentFacts, ids: dict[str, str]
    ) -> uuid.UUID | None:
        target, current = status_of(facts), tip.status
        if (current, target) not in TIP_EVENT_TRANSITIONS:
            logger.debug(
                "tip_event_no_move",
                extra={**_ids(ids, tip), "tip_status": current, "stripe_status": facts.status},
            )
            return None
        if not await self._tips.move_status(tip.id, facts.payment_intent_id, current, target):
            raise TipRowMissingError  # pragma: no cover - the row is locked
        logged = {**_ids(ids, tip), "tip_status": target.value}
        if target is TipStatus.SUCCEEDED:
            await self._timeline.tip_added(tip.job_id, tip.customer_id)
            logger.info("tip_succeeded", extra=logged)
            return tip.id
        logger.info("tip_status_moved", extra=logged)
        return None

    async def _adopt(self, tip: Tip, facts: TipIntentFacts, ids: dict[str, str]) -> bool:
        """Stores the current attempt's intent its create's answer lost, on the locked row."""
        try:
            async with self._session.begin_nested():
                stored = await self._tips.set_payment_intent_if_missing(
                    tip.id, tip.attempt, facts.payment_intent_id
                )
        except IntegrityError:
            # Another tip holds this intent (the unique column): nothing changes.
            stored = False
        if not stored:
            logger.warning("tip_event_not_adopted", extra=_ids(ids, tip))
            return False
        logger.warning("tip_payment_intent_adopted_from_event", extra=_ids(ids, tip))
        return True

    async def _contain(self, tip: Tip, ids: dict[str, str]) -> None:
        """An earlier attempt's intent succeeded: money no attempt holds. The tip is flagged
        for staff and takes no new choice; its current attempt's intent is canceled when it
        still can be (Stripe refusing: it is being paid, and staff see both)."""
        # Read before the flag's UPDATE, which expires the row's attributes.
        logged = _ids(ids, tip)
        intent, payable = tip.stripe_payment_intent_id, tip.status in UNPAID_STATUSES
        key = tip_cancel_idempotency_key(tip.id, tip.attempt, tip.updated_at)
        flagged = await self._tips.flag_late_success(tip.id)
        cancelled = False
        if flagged and intent is not None and payable:
            cancelled = await self._stripe.cancel_payment_intent(intent, idempotency_key=key)
        logger.error(
            "tip_succeeded_on_stale_attempt",
            extra={**logged, "current_canceled": str(cancelled).lower()},
        )


async def _queue_receipt(tip_id: uuid.UUID, queue: JobQueue, timeout_seconds: float) -> None:
    await enqueue_tip_receipt(queue, tip_id, timeout_seconds)


async def _queue_transfer(tip_id: uuid.UUID, queue: JobQueue, timeout_seconds: float) -> None:
    await enqueue_tip_transfer(queue, tip_id, timeout_seconds)


async def _announce(session: AsyncSession, tip_id: uuid.UUID, after_commit: AfterCommit) -> None:
    """What a tip that just succeeded sets off once its event commits: the receipt, the
    transfer and the pro's push (read now, in the event's transaction)."""
    after_commit.add(partial(_queue_receipt, tip_id))
    after_commit.add(partial(_queue_transfer, tip_id))
    tip = await TipRepository(session).get(tip_id)
    pro_user_id = None if tip is None else await ProService(session).user_id_of(tip.pro_id)
    if tip is None or pro_user_id is None:  # pragma: no cover - tips.pro_id is a foreign key
        return
    after_commit.add(
        partial(
            _push_tip,
            pro_user_id,
            tip_id,
            tip.job_id,
            await CustomerRequestReader(session).public_code(tip.request_id),
        )
    )


async def _push_tip(
    pro_user_id: uuid.UUID,
    tip_id: uuid.UUID,
    job_id: uuid.UUID,
    public_code: str,
    queue: JobQueue,
    timeout_seconds: float,
) -> None:
    await push_tip_received(
        queue,
        pro_user_id=pro_user_id,
        tip_id=tip_id,
        job_id=job_id,
        public_code=public_code,
        timeout_seconds=timeout_seconds,
    )


def tip_event_handler(stripe: StripePaymentsProvider) -> StripeEventHandler:
    """The handler, reading PaymentIntents with the client `stripe` gives (the worker's own in
    production, a fake in tests)."""

    async def tip_event(
        session: AsyncSession, event: StripeEvent, after_commit: AfterCommit
    ) -> None:
        intent_id = intent_event(event).intent_id  # a malformed object is raised
        ids = {"stripe_event_id": event.stripe_event_id, "event_type": event.event_type}
        client = stripe()
        if client is None:
            logger.warning("tips_stripe_not_configured", extra=ids)
            raise TipsStripeNotConfiguredError
        try:
            succeeded = await TipReconciler(session, client).apply(intent_id, ids)
        except StripeCallError as error:
            logger.warning(
                "tip_event_stripe_unavailable",
                extra={**ids, "error": type(error).__name__, "stripe_code": error.code},
            )
            raise
        if succeeded is not None:
            await _announce(session, succeeded, after_commit)

    return tip_event


TIP_INTENT_HANDLERS: Final[Mapping[str, StripeEventHandler]] = MappingProxyType(
    dict.fromkeys(TIP_EVENT_TYPES, tip_event_handler(worker_stripe_payments))
)
