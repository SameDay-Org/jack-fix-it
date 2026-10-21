import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.models import Job, JobEvent


class JobRepository:
    """Queries only. Status changes belong to JobStateMachine (service.py)."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_for_update(self, job_id: uuid.UUID) -> Job | None:
        """The job, locked until the transaction ends, so transitions on it run one at a time.

        populate_existing: a waiter gets the row as the transaction that held the lock left it.
        """
        statement = (
            select(Job)
            .where(Job.id == job_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def add_event(self, event: JobEvent) -> JobEvent:
        self._session.add(event)
        await self._session.flush()
        return event
