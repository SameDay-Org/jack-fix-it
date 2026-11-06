import uuid

from sqlalchemy import exists, select
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

    async def exists_for_request(self, request_id: uuid.UUID) -> bool:
        statement = select(exists().where(Job.request_id == request_id))
        return bool(await self._session.scalar(statement))

    async def add(self, job: Job) -> Job:
        """Inserts now (flush), with the status column's default (scheduled): the database
        guard (#163) lets that insert through. A second job for the request or the quote fails
        here, on their unique indexes."""
        self._session.add(job)
        await self._session.flush()
        return job

    async def add_event(self, event: JobEvent) -> JobEvent:
        self._session.add(event)
        await self._session.flush()
        return event
