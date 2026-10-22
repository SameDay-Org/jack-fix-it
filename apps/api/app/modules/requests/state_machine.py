"""RequestStateMachine: the only code that changes service_requests.status (D12.1, #160;
AGENTS.md).

Every change follows TRANSITIONS (transitions.py), locks the request row, logs
`request_status_changed` (ids and statuses only; there is no request_events table), and
answers:
- 404 for an unknown request, and for a customer who is not its owner (checked first, so a
  stranger never learns the request's state);
- 403 for a pro, whatever the edge: pros never move a request;
- 409 `invalid_transition` for an edge not in the table, including from a terminal status;
- 403 for an actor kind the edge does not allow.
A rejected transition changes nothing.

The caller owns the transaction: transition() flushes and never commits, so a feature can change
a request together with its own rows (a quote, a job) atomically.
"""

import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Final

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, PendingRollbackError
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import ForbiddenError, NotFoundError
from app.modules.jobs.service import SystemActor
from app.modules.requests.errors import InvalidTransitionError
from app.modules.requests.models import RequestStatus, ServiceRequest
from app.modules.requests.repository import ServiceRequestRepository
from app.modules.requests.transitions import TRANSITIONS, ActorKind
from app.modules.users.types import UserAccount, UserRole

logger = logging.getLogger(__name__)


# The database guard (#163): triggers on service_requests and jobs refuse a status change unless
# this transaction's app.status_writer names that very row ('<table>:<id>'). Only the state
# machines set it, around their own write (the static guard flags it anywhere else).
@asynccontextmanager
async def _status_writer(session: AsyncSession, request: ServiceRequest) -> AsyncIterator[None]:
    """Lets the block change this one request's status past the database guard.

    The token names the row, so the trigger refuses any other row or table that the block's
    flush might carry; and the unit of work must hold nothing else when the window opens
    (transition() drains it first), so that flush writes this row alone. The token is local to
    the transaction (is_local), so it never reaches another one on a pooled connection, and it
    is cleared when the block ends, even when it fails. If the failure aborted the transaction,
    it cannot be cleared here, but it goes with that transaction's rollback."""
    _require_clean(session, request)
    # Only here: the static guard allows this flag in this function alone (ALLOW_LIST).
    set_writer = text("SELECT set_config('app.status_writer', :value, true)")
    await session.execute(set_writer, {"value": f"{ServiceRequest.__tablename__}:{request.id}"})
    try:
        yield
    finally:
        try:
            await session.execute(set_writer, {"value": ""})
        except PendingRollbackError:
            pass  # the flush failed: the transaction, and the flag with it, will roll back
        except DBAPIError as error:
            if getattr(error.orig, "sqlstate", None) != _IN_FAILED_TRANSACTION:
                raise


def _require_clean(session: AsyncSession, request: ServiceRequest) -> None:
    """Nothing but the target request may be pending when its status window opens."""
    pending = [row for row in session.dirty if row is not request and session.is_modified(row)]
    if session.new or session.deleted or pending:
        raise RuntimeError("pending writes in the unit of work when a status window opens")


# Postgres refuses every statement in a transaction that already failed.
_IN_FAILED_TRANSACTION: Final = "25P02"
# The statuses are part of this service's interface: other modules take RequestStatus from here,
# never from requests.models (ADR 0003).
__all__ = ["LockedRequest", "RequestStateMachine", "RequestStatus"]

_ACTOR_KIND_BY_ROLE: Final = {
    UserRole.CUSTOMER: ActorKind.CUSTOMER,
    UserRole.AGENT: ActorKind.STAFF,
    UserRole.ADMIN: ActorKind.STAFF,
    # Pros: no kind, so every edge is a 403.
}


@dataclass(frozen=True)
class LockedRequest:
    """What a caller deciding a transition needs, read under the row lock."""

    id: uuid.UUID
    status: RequestStatus
    category_id: uuid.UUID | None
    address_id: uuid.UUID


class RequestStateMachine:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._requests = ServiceRequestRepository(session)

    async def lock(self, request_id: uuid.UUID) -> LockedRequest | None:
        """Locks the request until the transaction ends, for a caller that decides what to do
        from its state (dispatch, #48), then transitions in the same transaction. Runs of two
        such callers on one request take turns. None for an unknown request."""
        request = await self._requests.get_for_update(request_id)
        if request is None:
            return None
        return LockedRequest(request.id, request.status, request.category_id, request.address_id)

    async def transition(
        self, request_id: uuid.UUID, to: RequestStatus, actor: UserAccount | SystemActor
    ) -> RequestStatus:
        """Moves the request to `to` and returns its new status. Workers pass jobs' SYSTEM."""
        # Drain the unit of work first, outside any window: a pending status write anywhere
        # (this request included) hits the database guard here, unauthorized, instead of riding
        # along with this transition's flush or being taken for its starting status.
        await self._session.flush()
        request = await self._requests.get_for_update(request_id)
        if request is None:
            raise NotFoundError
        kind = self._actor_kind(request, actor)
        if kind is None:
            raise ForbiddenError
        allowed = TRANSITIONS.get((request.status, to))
        if allowed is None:
            raise InvalidTransitionError
        if kind not in allowed:
            raise ForbiddenError

        from_status = request.status
        async with _status_writer(self._session, request):
            request.status = to
            await self._session.flush()
        logger.info(
            "request_status_changed",
            extra={
                # Not "request_id": that is the HTTP correlation id in every log line.
                "service_request_id": str(request.id),
                "from_status": str(from_status),
                "to_status": str(to),
                "actor_kind": str(kind),
                "actor_id": None if isinstance(actor, SystemActor) else str(actor.id),
            },
        )
        return to

    @staticmethod
    def _actor_kind(request: ServiceRequest, actor: UserAccount | SystemActor) -> ActorKind | None:
        """The actor's kind for this request. 404 for a customer who is not its owner."""
        if isinstance(actor, SystemActor):
            return ActorKind.SYSTEM
        kind = _ACTOR_KIND_BY_ROLE.get(actor.role)
        if kind is ActorKind.CUSTOMER and actor.id != request.customer_id:
            raise NotFoundError
        return kind
