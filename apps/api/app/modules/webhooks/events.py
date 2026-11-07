"""What a Stripe event handler receives (#40). A leaf: the feature modules that handle events
(payments, #61) import it without importing the registry in handlers.py, which imports them."""

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
