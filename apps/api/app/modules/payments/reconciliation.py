"""Payment reconciliation (D11.3, #61): what the PaymentIntent's events do to the payment, the
request, its quotes and the job. The worker runs it through the Stripe webhook base (#40):
once per event, in the worker's transaction, which it never commits.

Every event finds the payment by its PaymentIntent id; an unknown intent is a warning (the event
id and type only) and changes nothing. Then the locks, in the order the payment call (#58) and
the acceptance (#189) take them, so the three take turns and never deadlock: the request, the
payment's quote, the payment (each FOR UPDATE, read as last committed). Then, before anything
else, the event must match the row: its amount the payment's customer_total_cents, its currency
usd, its customer the customer's Stripe Customer. A mismatch changes nothing, logs
`payment_event_mismatch` (ids and the names of the fields that differ) and raises, so the event
is retried and then ends failed for staff.

The payment's status then moves along PAYMENT_TRANSITIONS (transitions.py); a move that is not
there (an out-of-order event, a repeat, anything after succeeded or canceled) changes nothing
and is logged at debug level.
- processing, payment_failed: the payment's status only. A failed payment keeps its quote
  accepted and the request accepted: the customer retries with the same PaymentIntent. The
  failure's Stripe code (`last_payment_error.code`, never its message) is logged with the ids.
- succeeded: the payment succeeds and, while the request can still take a job (accepted, with
  this payment's quote as its accepted one, and no job yet), the job is created, scheduled,
  with the amounts frozen on the payment and a `created` event, and the request's other pending
  quotes are rejected. Otherwise the payment still succeeds (the money was taken) but no job is
  created: `payment_succeeded_without_job` (an ERROR, ids) asks staff for a refund (#69, #76).
- canceled: the payment is canceled and, while the request is accepted with this payment's
  quote, the quote is un-accepted (pending before its expires_at, else expired) and the request
  goes back to quote_ready (SYSTEM); with no pending or accepted quote left it backs out to
  finding_pro (SYSTEM), as the expiry sweep (#51) would. Another quote can then be accepted.

Statuses change only through the state machines (requests), conditional updates under the row
locks (quotes, payments) and the job's insert in its default status (jobs). Logs carry ids, the
event type, statuses and Stripe codes only: no amounts, no customer data, no PaymentIntent id.
"""

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.service import SYSTEM, JobScheduler, NewJob
from app.modules.payments.models import CURRENCY, Payment, PaymentStatus
from app.modules.payments.repository import PaymentRepository
from app.modules.payments.transitions import TERMINAL_STATES, allowed
from app.modules.quotes.service import LockedQuote, QuoteReader, QuoteSettlement
from app.modules.requests.state_machine import LockedRequest, RequestStateMachine, RequestStatus
from app.modules.users.service import UserService

logger = logging.getLogger(__name__)


class PaymentEventMismatchError(Exception):
    """The event's amount, currency or customer differ from the payment row's: nothing changes,
    and the event ends failed for staff."""


class PaymentRowMissingError(Exception):
    """The payment, its request or its quote vanished between the lookup and the locks; rows are
    never deleted, so the event is retried."""


@dataclass(frozen=True)
class IntentEvent:
    """A payment_intent.* event as the reconciliation reads it."""

    stripe_event_id: str
    event_type: str
    intent_id: str
    amount: int
    currency: str
    # The Stripe Customer's id; None when the intent has none.
    customer: str | None
    # `last_payment_error.code` (payment_failed); never the message.
    failure_code: str | None


@dataclass(frozen=True)
class _Locked:
    request: LockedRequest
    quote: LockedQuote
    payment: Payment
    ids: dict[str, str]


class PaymentReconciler:
    """Applies one PaymentIntent event (see the module doc). The caller owns the transaction:
    it flushes and never commits."""

    def __init__(self, session: AsyncSession) -> None:
        self._payments = PaymentRepository(session)
        self._requests = RequestStateMachine(session)
        self._quotes = QuoteReader(session)
        self._settlement = QuoteSettlement(session)
        self._jobs = JobScheduler(session)
        self._users = UserService(session)

    async def apply(self, event: IntentEvent, to: PaymentStatus) -> None:
        """Moves the event's payment to `to`, with what that move does to the request, its
        quotes and the job (see the module doc)."""
        locked = await self._lock(event)
        if locked is None:
            return
        await self._check_integrity(event, locked)
        current = locked.payment.status
        if to is PaymentStatus.FAILED and current not in TERMINAL_STATES:
            # Every failed attempt, even a repeat of the status: the code helps support.
            logger.warning(
                "payment_attempt_failed", extra={**locked.ids, "stripe_code": event.failure_code}
            )
        if not allowed(current, to):
            logger.debug(
                "payment_event_ignored", extra={**locked.ids, "payment_status": str(current)}
            )
            return
        if not await self._payments.move_status(locked.payment.id, current, to):
            # The row is locked from the read to the commit.
            raise RuntimeError("payment status changed under its lock")  # pragma: no cover
        if to is PaymentStatus.SUCCEEDED:
            await self._schedule(locked)
        elif to is PaymentStatus.CANCELED:
            await self._reopen(locked)
        # After the last write: a step that fails above rolls the move back, unlogged.
        logger.info(
            "payment_status_changed",
            extra={**locked.ids, "from_status": str(current), "to_status": str(to)},
        )

    async def _lock(self, event: IntentEvent) -> _Locked | None:
        """The request, the quote and the payment, locked in that order; None (logged) for an
        unknown PaymentIntent."""
        found = await self._payments.find_by_intent(event.intent_id)
        if found is None:
            logger.warning(
                "payment_event_unknown_intent",
                extra={"stripe_event_id": event.stripe_event_id, "event_type": event.event_type},
            )
            return None
        payment_id, request_id, quote_id = found
        request = await self._requests.lock(request_id)
        quote = await self._quotes.lock_of_request(quote_id, request_id)
        payment = await self._payments.get_for_update(payment_id)
        if request is None or quote is None or payment is None:
            raise PaymentRowMissingError  # pragma: no cover - foreign keys; nothing is deleted
        ids = {
            "payment_id": str(payment.id),
            "quote_id": str(quote.id),
            "service_request_id": str(request.id),
            "stripe_event_id": event.stripe_event_id,
            "event_type": event.event_type,
        }
        return _Locked(request, quote, payment, ids)

    async def _check_integrity(self, event: IntentEvent, locked: _Locked) -> None:
        payment = locked.payment
        customer = await self._users.stripe_customer_id(payment.customer_id)
        mismatched = [
            name
            for name, differs in (
                ("amount", event.amount != payment.customer_total_cents),
                ("currency", event.currency != CURRENCY or payment.currency != CURRENCY),
                ("customer", customer is None or event.customer != customer),
            )
            if differs
        ]
        if mismatched:
            logger.error(
                "payment_event_mismatch", extra={**locked.ids, "fields": ",".join(mismatched)}
            )
            raise PaymentEventMismatchError

    async def _schedule(self, locked: _Locked) -> None:
        """The payment succeeded: the job, when the request can still take one."""
        request, quote, payment = locked.request, locked.quote, locked.payment
        can_take = (
            request.status is RequestStatus.ACCEPTED
            and quote.accepted
            and not await self._jobs.has_job(request.id)
        )
        if not can_take:
            logger.error(
                "payment_succeeded_without_job",
                extra={**locked.ids, "request_status": str(request.status)},
            )
            return
        job_id = await self._jobs.schedule(
            NewJob(
                request_id=request.id,
                quote_id=quote.id,
                customer_id=payment.customer_id,
                pro_id=quote.pro_id,
                customer_price_cents=payment.amount_cents,
                pro_payout_cents=payment.pro_payout_cents,
                platform_fee_cents=payment.platform_fee_cents,
                tax_cents=payment.tax_cents,
            )
        )
        rejected = await self._settlement.reject_others(request.id, quote.id)
        logger.info(
            "job_scheduled",
            extra={**locked.ids, "job_id": str(job_id), "rejected_quotes": len(rejected)},
        )

    async def _reopen(self, locked: _Locked) -> None:
        """The payment was canceled: the quote and the request reopen, when the request still
        waits on this quote."""
        request, quote = locked.request, locked.quote
        if request.status is not RequestStatus.ACCEPTED or not quote.accepted:
            logger.info(
                "payment_canceled_nothing_to_reopen",
                extra={**locked.ids, "request_status": str(request.status)},
            )
            return
        quote_status = await self._settlement.unaccept(quote.id, datetime.now(UTC))
        if quote_status is None:
            raise RuntimeError("quote changed under its lock")  # pragma: no cover
        request_status = await self._requests.transition(
            request.id, RequestStatus.QUOTE_READY, SYSTEM
        )
        if not await self._settlement.has_live(request.id):
            request_status = await self._requests.transition(
                request.id, RequestStatus.FINDING_PRO, SYSTEM
            )
        logger.info(
            "payment_canceled_quote_reopened",
            extra={
                **locked.ids,
                "quote_status": str(quote_status),
                "request_status": str(request_status),
            },
        )
