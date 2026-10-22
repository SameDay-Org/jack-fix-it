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
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import ForbiddenError, NotFoundError
from app.modules.jobs.service import SystemActor
from app.modules.requests.errors import InvalidTransitionError
from app.modules.requests.models import RequestStatus, ServiceRequest
from app.modules.requests.repository import ServiceRequestRepository
from app.modules.requests.transitions import TRANSITIONS, ActorKind
from app.modules.users.types import UserAccount, UserRole

logger = logging.getLogger(__name__)

_ACTOR_KIND_BY_ROLE: Final = {
    UserRole.CUSTOMER: ActorKind.CUSTOMER,
    UserRole.AGENT: ActorKind.STAFF,
    UserRole.ADMIN: ActorKind.STAFF,
    # Pros: no kind, so every edge is a 403.
}


class RequestStateMachine:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._requests = ServiceRequestRepository(session)

    async def transition(
        self, request_id: uuid.UUID, to: RequestStatus, actor: UserAccount | SystemActor
    ) -> RequestStatus:
        """Moves the request to `to` and returns its new status. Workers pass jobs' SYSTEM."""
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
