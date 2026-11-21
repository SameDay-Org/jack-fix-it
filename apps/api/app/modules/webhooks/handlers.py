"""Stripe event handlers (D7.3, #40): the event types the platform acts on.

HANDLERS maps an event type to the coroutine the worker runs for it. An event whose type has no
handler is stored as ignored when it arrives and never queued. The table is built here, at
import, from the feature modules' own tables, so the API (which decides pending or ignored on
arrival) and the worker (which runs the handler) always read the same one: payment_intent.*
(#61), transfer.reversed (#68), account.updated (#280) and the refund events of a dispute's
refund (refund.updated, refund.failed, charge.refund.updated: #433 round 1).

A payment_intent.* event goes to the job payment's handler, or to a tip's (#273) when its
PaymentIntent's metadata kind is "tip": one handler per event, chosen by the event itself, so a
tip never touches a payment and a payment never touches a tip. transfer.reversed goes the same
way by its Transfer's metadata kind (#273 PR A2): a tip's transfer to the tips module, any other
to the job transfer's handler. The kind routes; only the exact Stripe id selects a row.

CONNECT_EVENT_TYPES are the ones the Connect endpoint (POST /v1/webhooks/stripe/connect, its own
secret) takes: events of the pros' connected accounts. Any other type arriving there is stored
as ignored. transfer.reversed and the refund events are the platform's own (a transfer and a
refund are the platform's objects): they come to the platform endpoint.

A handler gets the stored event and the worker's session. It writes through other modules'
services and never commits: the worker marks the event processed in the same transaction, and
on an error rolls the handler's writes back and runs it again later.
"""

from collections.abc import Mapping

from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.stripe_payments import TIP_INTENT_KIND
from app.modules.disputes.refund_webhooks import REFUND_HANDLERS
from app.modules.payments.transfer_webhooks import TRANSFER_HANDLERS, transfer_kind
from app.modules.payments.webhook_handlers import PAYMENT_INTENT_HANDLERS, intent_kind
from app.modules.payouts.webhook_handlers import ACCOUNT_HANDLERS
from app.modules.tips.transfer_webhooks import TIP_TRANSFER_REVERSED
from app.modules.tips.webhooks import TIP_INTENT_HANDLERS
from app.modules.webhooks.events import AfterCommit, StripeEvent, StripeEventHandler

__all__ = ["CONNECT_EVENT_TYPES", "HANDLERS", "StripeEvent", "StripeEventHandler", "handler_for"]


def _by_intent_kind(payment: StripeEventHandler, tip: StripeEventHandler) -> StripeEventHandler:
    async def handle(session: AsyncSession, event: StripeEvent, after_commit: AfterCommit) -> None:
        if intent_kind(event) == TIP_INTENT_KIND:
            await tip(session, event, after_commit)
        else:
            await payment(session, event, after_commit)

    handle.__name__ = payment.__name__
    return handle


def _intent_handlers(
    payments: Mapping[str, StripeEventHandler], tips: Mapping[str, StripeEventHandler]
) -> dict[str, StripeEventHandler]:
    if set(payments) != set(tips):  # pragma: no cover - both tables list the same four types
        raise RuntimeError("the payment and tip PaymentIntent handlers must cover the same events")
    return {
        event_type: _by_intent_kind(handler, tips[event_type])
        for event_type, handler in payments.items()
    }


def _by_transfer_kind(job: StripeEventHandler, tip: StripeEventHandler) -> StripeEventHandler:
    async def handle(session: AsyncSession, event: StripeEvent, after_commit: AfterCommit) -> None:
        if transfer_kind(event) == TIP_INTENT_KIND:
            await tip(session, event, after_commit)
        else:
            await job(session, event, after_commit)

    handle.__name__ = job.__name__
    return handle


HANDLERS: dict[str, StripeEventHandler] = {
    **_intent_handlers(PAYMENT_INTENT_HANDLERS, TIP_INTENT_HANDLERS),
    **TRANSFER_HANDLERS,
    "transfer.reversed": _by_transfer_kind(
        TRANSFER_HANDLERS["transfer.reversed"], TIP_TRANSFER_REVERSED
    ),
    **REFUND_HANDLERS,
    **ACCOUNT_HANDLERS,
}
CONNECT_EVENT_TYPES: frozenset[str] = frozenset(ACCOUNT_HANDLERS)


def handler_for(event_type: str) -> StripeEventHandler | None:
    return HANDLERS.get(event_type)
