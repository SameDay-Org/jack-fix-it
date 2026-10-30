"""Stripe event handlers (D7.3, #40): the event types the platform acts on.

HANDLERS maps an event type to the coroutine the worker runs for it. An event whose type has no
handler is stored as ignored when it arrives and never queued. None is registered yet:
account.updated (#280) and payment_intent.* (#61) add theirs here.

A handler gets the stored event and the worker's session. It writes through other modules'
services and never commits: the worker marks the event processed in the same transaction, and
on an error rolls the handler's writes back and runs it again later.
"""

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class StripeEvent:
    stripe_event_id: str
    event_type: str
    livemode: bool
    created: datetime
    # The whole event, as Stripe sent it; a handler reads its `data.object`.
    payload: Mapping[str, object]


StripeEventHandler = Callable[[AsyncSession, StripeEvent], Awaitable[None]]

HANDLERS: dict[str, StripeEventHandler] = {}


def handler_for(event_type: str) -> StripeEventHandler | None:
    return HANDLERS.get(event_type)
