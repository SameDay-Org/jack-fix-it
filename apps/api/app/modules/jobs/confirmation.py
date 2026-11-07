"""The system's side of a job's confirmation (#67): the 48 h auto-confirm.

Once the pro marks the job done (completed, which sets completed_at), the customer has
JOB_AUTO_CONFIRM_AFTER_HOURS to confirm it (#66, JobExecutionService.confirm) or report a
problem (#75: the job goes disputed). A job still completed once that window has passed is
confirmed by the system (Cesar 2026-10-29, epic #272): "keep the 48 h auto-confirm if the customer
never answers, unless a problem is open". The window is due at its very end: a job whose
completed_at is exactly the window before `now` is confirmed.

JobAutoConfirmer reads the due jobs unlocked, then confirms each one under its row lock after
reading it again: only a job still completed, with completed_at at or before the cut-off, moves,
through JobStateMachine with the system as actor (its job_events row has no actor_id). A job the
customer confirmed meanwhile, or one with a problem open (disputed), or anything else, is left
as it is. So a run racing the customer, or another run, makes exactly one transition and one
event. The caller owns the transaction (tasks.py: one per job), and pushes the pro once it
commits (#65's job_confirmed, the same message id the customer's confirm uses).
"""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.models import Job, JobStatus
from app.modules.jobs.repository import JobRepository
from app.modules.jobs.service import SYSTEM, JobStateMachine
from app.modules.pros.service import ProService
from app.modules.requests.service import CustomerRequestReader


@dataclass(frozen=True)
class AutoConfirmed:
    """A job the system confirmed, with what its pro's push needs once the commit is done."""

    job_id: uuid.UUID
    pro_user_id: uuid.UUID | None
    public_code: str


def confirm_by(job: Job, window: timedelta) -> datetime | None:
    """When the system confirms the job if the customer has not: completed_at plus the window,
    while the job is completed; None in every other status."""
    if job.status is not JobStatus.COMPLETED or job.completed_at is None:
        return None
    return job.completed_at + window


class JobAutoConfirmer:
    def __init__(self, session: AsyncSession) -> None:
        self._jobs = JobRepository(session)
        self._pros = ProService(session)
        self._machine = JobStateMachine(session, self._pros)
        self._requests = CustomerRequestReader(session)

    async def due(
        self, completed_before: datetime, after: uuid.UUID | None, limit: int
    ) -> list[uuid.UUID]:
        """Up to `limit` ids of the completed jobs with completed_at at or before
        `completed_before` (now minus the window), by id, after `after`. Unlocked."""
        return await self._jobs.completed_before(completed_before, after, limit)

    async def confirm_if_due(
        self, job_id: uuid.UUID, completed_before: datetime
    ) -> AutoConfirmed | None:
        """Confirms the job as the system if, under its lock, it is still completed with
        completed_at at or before `completed_before`; None (nothing changed) otherwise. Flushes,
        never commits."""
        job = await self._jobs.get_for_update(job_id)
        if (
            job is None
            or job.status is not JobStatus.COMPLETED
            or job.completed_at is None
            or job.completed_at > completed_before
        ):
            return None
        await self._machine.transition(job.id, JobStatus.CONFIRMED, SYSTEM)
        return AutoConfirmed(
            job_id=job.id,
            pro_user_id=await self._pros.user_id_of(job.pro_id),
            public_code=await self._requests.public_code(job.request_id),
        )
