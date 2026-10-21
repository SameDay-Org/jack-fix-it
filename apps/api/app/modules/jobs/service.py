"""JobStateMachine: the only code that changes jobs.status (D12.1, #60; AGENTS.md).

Every change follows TRANSITIONS (transitions.py), locks the job row, writes one job_events row
in the same transaction, and answers:
- 404 for an unknown job, and for a customer or pro who is not the job's own (checked first, so
  a stranger never learns the job's state);
- 409 `invalid_transition` for an edge not in the table, including from a terminal status;
- 403 for an actor kind the edge does not allow.
A rejected transition changes nothing and writes no event.

The caller owns the transaction: transition() flushes and never commits, so a feature can
change a job together with its own rows (payments, photos, disputes) atomically.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import ForbiddenError, NotFoundError
from app.modules.jobs.errors import InvalidTransitionError
from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.jobs.repository import JobRepository
from app.modules.jobs.transitions import TRANSITIONS, ActorKind
from app.modules.pros.service import ProService
from app.modules.users.types import UserAccount, UserRole

STATUS_CHANGED: Final = "status_changed"


@dataclass(frozen=True)
class SystemActor:
    """A worker acting on its own (48 h auto-confirm, transfers): events get no actor_id."""


SYSTEM: Final = SystemActor()

_ACTOR_KIND_BY_ROLE: Final = {
    UserRole.CUSTOMER: ActorKind.CUSTOMER,
    UserRole.PRO: ActorKind.PRO,
    UserRole.ADMIN: ActorKind.ADMIN,
    # Agents (BDC) take no part in a job's status.
}

# The timestamp each status sets on entry, once.
_ENTRY_TIMESTAMPS: Final = {
    JobStatus.IN_PROGRESS: "started_at",
    JobStatus.COMPLETED: "completed_at",
    JobStatus.CONFIRMED: "confirmed_at",
}


class JobStateMachine:
    def __init__(self, session: AsyncSession, pros: ProService) -> None:
        self._jobs = JobRepository(session)
        self._pros = pros

    async def transition(
        self,
        job_id: uuid.UUID,
        to: JobStatus,
        actor: UserAccount | SystemActor,
        *,
        lat: Decimal | None = None,
        lng: Decimal | None = None,
        event_type: str = STATUS_CHANGED,
    ) -> Job:
        job = await self._jobs.get_for_update(job_id)
        if job is None:
            raise NotFoundError
        kind = await self._actor_kind(job, actor)
        allowed = TRANSITIONS.get((job.status, to))
        if allowed is None:
            raise InvalidTransitionError
        if kind is None or kind not in allowed:
            raise ForbiddenError

        from_status = job.status
        now = datetime.now(UTC)
        timestamp = _ENTRY_TIMESTAMPS.get(to)
        if timestamp is not None and getattr(job, timestamp) is None:
            setattr(job, timestamp, now)
        job.status = to
        await self._jobs.add_event(
            JobEvent(
                job_id=job.id,
                type=event_type,
                from_status=from_status,
                to_status=to,
                actor_id=None if isinstance(actor, SystemActor) else actor.id,
                lat=lat,
                lng=lng,
            )
        )
        return job

    async def _actor_kind(self, job: Job, actor: UserAccount | SystemActor) -> ActorKind | None:
        """The actor's kind for this job. 404 for a customer or pro who is not the job's own."""
        if isinstance(actor, SystemActor):
            return ActorKind.SYSTEM
        kind = _ACTOR_KIND_BY_ROLE.get(actor.role)
        if kind is ActorKind.CUSTOMER and actor.id != job.customer_id:
            raise NotFoundError
        if kind is ActorKind.PRO:
            profile_id = await self._pros.get_profile_id_for_user(actor.id)
            if profile_id != job.pro_id:
                raise NotFoundError
        return kind
