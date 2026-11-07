"""The payment_intent.* handlers (D11.3, #61), registered in app.modules.webhooks.handlers.

Each reads the event's PaymentIntent and hands it to PaymentReconciler (reconciliation.py) with
the payment status the event stands for, and the metadata payment_id it may adopt the intent for
(#296; anything but a string there is read as none). A handler never commits: the worker does
(#40). What the reconciliation did that people hear about (#65), it announces after that commit
(AfterCommit): a job booked pushes the customer and the pro; a canceled payment that reopened
the quotes pushes the customer. An event whose object is not a PaymentIntent with an id, an
integer amount and a currency is malformed: logged (the event id and type) and raised, so it
ends failed for staff.
"""

import logging
from collections.abc import Mapping
from functools import partial
from types import MappingProxyType
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications.events import (
    push_booking_not_completed,
    push_job_booked,
    push_job_scheduled,
)
from app.modules.payments.models import PaymentStatus
from app.modules.payments.reconciliation import (
    BookingReopened,
    IntentEvent,
    JobBooked,
    PaymentReconciler,
    Reconciled,
)
from app.modules.webhooks.events import AfterCommit, StripeEvent, StripeEventHandler
from app.queue import JobQueue

logger = logging.getLogger(__name__)

# Stripe's error codes are short identifiers; anything longer is cut before it is logged.
_CODE_LENGTH: Final = 64


class PaymentEventMalformedError(Exception):
    """The event's object is not a PaymentIntent the reconciliation can read."""


def intent_event(event: StripeEvent) -> IntentEvent:
    """The event's PaymentIntent, as the reconciliation reads it."""
    data = event.payload.get("data")
    intent = data.get("object") if isinstance(data, Mapping) else None
    if not isinstance(intent, Mapping):
        raise _malformed(event)
    intent_id = intent.get("id")
    amount = intent.get("amount")
    currency = intent.get("currency")
    if (
        intent.get("object") != "payment_intent"
        or not isinstance(intent_id, str)
        or type(amount) is not int
        or not isinstance(currency, str)
    ):
        raise _malformed(event)
    customer = intent.get("customer")
    if isinstance(customer, Mapping):  # an expanded Customer
        customer = customer.get("id")
    error = intent.get("last_payment_error")
    code = error.get("code") if isinstance(error, Mapping) else None
    metadata = intent.get("metadata")
    named = metadata.get("payment_id") if isinstance(metadata, Mapping) else None
    return IntentEvent(
        stripe_event_id=event.stripe_event_id,
        event_type=event.event_type,
        intent_id=intent_id,
        amount=amount,
        currency=currency,
        customer=customer if isinstance(customer, str) else None,
        failure_code=code[:_CODE_LENGTH] if isinstance(code, str) else None,
        metadata_payment_id=named if isinstance(named, str) else None,
    )


def _malformed(event: StripeEvent) -> PaymentEventMalformedError:
    logger.error(
        "payment_event_malformed",
        extra={"stripe_event_id": event.stripe_event_id, "event_type": event.event_type},
    )
    return PaymentEventMalformedError()


async def announce(outcome: Reconciled, queue: JobQueue, timeout_seconds: float) -> None:
    """The pushes for what the reconciliation did, after the worker's commit (#65)."""
    if isinstance(outcome, JobBooked):
        await push_job_booked(
            queue,
            customer_id=outcome.customer_id,
            job_id=outcome.job_id,
            request_id=outcome.request_id,
            public_code=outcome.public_code,
            timeout_seconds=timeout_seconds,
        )
        await push_job_scheduled(
            queue,
            pro_user_id=outcome.pro_user_id,
            job_id=outcome.job_id,
            public_code=outcome.public_code,
            timeout_seconds=timeout_seconds,
        )
    elif isinstance(outcome, BookingReopened):
        await push_booking_not_completed(
            queue,
            customer_id=outcome.customer_id,
            payment_id=outcome.payment_id,
            request_id=outcome.request_id,
            public_code=outcome.public_code,
            timeout_seconds=timeout_seconds,
        )


def _moving_to(status: PaymentStatus) -> StripeEventHandler:
    async def handle(session: AsyncSession, event: StripeEvent, after_commit: AfterCommit) -> None:
        outcome = await PaymentReconciler(session).apply(intent_event(event), status)
        if outcome is not None:
            after_commit.add(partial(announce, outcome))

    handle.__name__ = f"payment_intent_{status}"
    return handle


PAYMENT_INTENT_HANDLERS: Final[Mapping[str, StripeEventHandler]] = MappingProxyType(
    {
        "payment_intent.processing": _moving_to(PaymentStatus.PROCESSING),
        "payment_intent.payment_failed": _moving_to(PaymentStatus.FAILED),
        "payment_intent.succeeded": _moving_to(PaymentStatus.SUCCEEDED),
        "payment_intent.canceled": _moving_to(PaymentStatus.CANCELED),
    }
)
