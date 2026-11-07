"""Stripe event handlers (D7.3, #40): the event types the platform acts on.

HANDLERS maps an event type to the coroutine the worker runs for it. An event whose type has no
handler is stored as ignored when it arrives and never queued. The table is built here, at
import, from the feature modules' own tables, so the API (which decides pending or ignored on
arrival) and the worker (which runs the handler) always read the same one: payment_intent.*
(#61) now; account.updated (#280) adds its own.

A handler gets the stored event and the worker's session. It writes through other modules'
services and never commits: the worker marks the event processed in the same transaction, and
on an error rolls the handler's writes back and runs it again later.
"""

from app.modules.payments.webhook_handlers import PAYMENT_INTENT_HANDLERS
from app.modules.webhooks.events import StripeEvent, StripeEventHandler

__all__ = ["HANDLERS", "StripeEvent", "StripeEventHandler", "handler_for"]

HANDLERS: dict[str, StripeEventHandler] = {**PAYMENT_INTENT_HANDLERS}


def handler_for(event_type: str) -> StripeEventHandler | None:
    return HANDLERS.get(event_type)
