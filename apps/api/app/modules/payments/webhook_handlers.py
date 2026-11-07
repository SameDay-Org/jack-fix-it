"""The payment_intent.* handlers (D11.3, #61), registered in app.modules.webhooks.handlers.

Each reads the event's PaymentIntent and hands it to PaymentReconciler (reconciliation.py) with
the payment status the event stands for. A handler never commits: the worker does (#40). An
event whose object is not a PaymentIntent with an id, an integer amount and a currency is
malformed: logged (the event id and type) and raised, so it ends failed for staff.
"""

import logging
from collections.abc import Mapping
from types import MappingProxyType
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.payments.models import PaymentStatus
from app.modules.payments.reconciliation import IntentEvent, PaymentReconciler
from app.modules.webhooks.events import StripeEvent, StripeEventHandler

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
    return IntentEvent(
        stripe_event_id=event.stripe_event_id,
        event_type=event.event_type,
        intent_id=intent_id,
        amount=amount,
        currency=currency,
        customer=customer if isinstance(customer, str) else None,
        failure_code=code[:_CODE_LENGTH] if isinstance(code, str) else None,
    )


def _malformed(event: StripeEvent) -> PaymentEventMalformedError:
    logger.error(
        "payment_event_malformed",
        extra={"stripe_event_id": event.stripe_event_id, "event_type": event.event_type},
    )
    return PaymentEventMalformedError()


def _moving_to(status: PaymentStatus) -> StripeEventHandler:
    async def handle(session: AsyncSession, event: StripeEvent) -> None:
        await PaymentReconciler(session).apply(intent_event(event), status)

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
