"""What a Stripe event handler receives (#40). A leaf: the feature modules that handle events
(payments, #61) import it without importing the registry in handlers.py, which imports them."""

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.queue import JobQueue


@dataclass(frozen=True)
class StripeEvent:
    stripe_event_id: str
    event_type: str
    livemode: bool
    created: datetime
    # The whole event, as Stripe sent it; a handler reads its `data.object`.
    payload: Mapping[str, object]


# Work for after the worker's commit (#65), e.g. a push: given the worker's queue and the enqueue
# timeout. It must never raise for a queue failure (notifications.events logs and drops it).
AfterCommitAction = Callable[[JobQueue, float], Awaitable[None]]


class AfterCommit:
    """What a handler announces once its writes are committed (#65). A handler never commits,
    so it cannot push itself: it adds the action here, and the worker runs it after the commit
    that marks the event processed. A handler error, or a commit that fails, drops it: nothing
    is announced for writes that were rolled back."""

    def __init__(self) -> None:
        self._actions: list[AfterCommitAction] = []

    def add(self, action: AfterCommitAction) -> None:
        self._actions.append(action)

    @property
    def actions(self) -> tuple[AfterCommitAction, ...]:
        return tuple(self._actions)


StripeEventHandler = Callable[[AsyncSession, StripeEvent, AfterCommit], Awaitable[None]]
