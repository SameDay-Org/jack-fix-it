import uuid
from collections.abc import Collection
from datetime import datetime

from sqlalchemy import Subquery, exists, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.models import Job, JobEvent, JobStatus


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

    async def get_of_request(self, request_id: uuid.UUID) -> Job | None:
        """The request's job (one per request), unlocked: for reads."""
        return (
            await self._session.scalars(select(Job).where(Job.request_id == request_id))
        ).one_or_none()

    async def get(self, job_id: uuid.UUID) -> Job | None:
        """The job, unlocked: for reads."""
        return await self._session.get(Job, job_id)

    async def page_for_pro(
        self,
        pro_id: uuid.UUID,
        statuses: Collection[JobStatus] | None,
        starts: Subquery,
        limit: int,
        before: tuple[datetime, uuid.UUID] | None,
    ) -> list[tuple[Job, datetime]]:
        """The pro's jobs with their scheduled start, newest scheduled first (the start in
        `starts`, the quotes module's quote_id/start_at subquery, then the job id), optionally
        in `statuses` only, after the cursor `before` (a start and a job id)."""
        start = starts.c.start_at
        statement = (
            select(Job, start)
            .join(starts, starts.c.quote_id == Job.quote_id)
            .where(Job.pro_id == pro_id)
        )
        if statuses is not None:
            statement = statement.where(Job.status.in_(statuses))
        if before is not None:
            statement = statement.where(tuple_(start, Job.id) < tuple_(*before))
        statement = statement.order_by(start.desc(), Job.id.desc()).limit(limit)
        return [(job, at) for job, at in (await self._session.execute(statement)).all()]

    async def events_of(self, job_id: uuid.UUID) -> list[JobEvent]:
        """The job's history, oldest first."""
        statement = (
            select(JobEvent)
            .where(JobEvent.job_id == job_id)
            .order_by(JobEvent.created_at, JobEvent.id)
        )
        return list((await self._session.scalars(statement)).all())

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
