"""Stripe event handlers (D7.3, #40): the event types the platform acts on.

HANDLERS maps an event type to the coroutine the worker runs for it. An event whose type has no
handler is stored as ignored when it arrives and never queued. The table is built here, at
import, from the feature modules' own tables, so the API (which decides pending or ignored on
arrival) and the worker (which runs the handler) always read the same one: payment_intent.*
(#61), transfer.reversed (#68), account.updated (#280) and the refund events of a dispute's
refund (refund.updated, refund.failed, charge.refund.updated: #433 round 1).

CONNECT_EVENT_TYPES are the ones the Connect endpoint (POST /v1/webhooks/stripe/connect, its own
secret) takes: events of the pros' connected accounts. Any other type arriving there is stored
as ignored. transfer.reversed and the refund events are the platform's own (a transfer and a
refund are the platform's objects): they come to the platform endpoint.

A handler gets the stored event and the worker's session. It writes through other modules'
services and never commits: the worker marks the event processed in the same transaction, and
on an error rolls the handler's writes back and runs it again later.
"""

from app.modules.disputes.refund_webhooks import REFUND_HANDLERS
from app.modules.payments.transfer_webhooks import TRANSFER_HANDLERS
from app.modules.payments.webhook_handlers import PAYMENT_INTENT_HANDLERS
from app.modules.payouts.webhook_handlers import ACCOUNT_HANDLERS
from app.modules.webhooks.events import StripeEvent, StripeEventHandler

__all__ = ["CONNECT_EVENT_TYPES", "HANDLERS", "StripeEvent", "StripeEventHandler", "handler_for"]

HANDLERS: dict[str, StripeEventHandler] = {
    **PAYMENT_INTENT_HANDLERS,
    **TRANSFER_HANDLERS,
    **REFUND_HANDLERS,
    **ACCOUNT_HANDLERS,
}
CONNECT_EVENT_TYPES: frozenset[str] = frozenset(ACCOUNT_HANDLERS)


def handler_for(event_type: str) -> StripeEventHandler | None:
    return HANDLERS.get(event_type)
