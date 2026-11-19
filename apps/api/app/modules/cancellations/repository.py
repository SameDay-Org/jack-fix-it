import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.cancellations.models import JobCancellation


class CancellationRepository:
    """The job_cancellations table (#69). Rows are written once, never updated."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def of_job(self, job_id: uuid.UUID) -> JobCancellation | None:
        statement = (
            select(JobCancellation)
            .where(JobCancellation.job_id == job_id)
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def by_idempotency_key(
        self, user_id: uuid.UUID, key: uuid.UUID
    ) -> JobCancellation | None:
        statement = select(JobCancellation).where(
            JobCancellation.cancelled_by == user_id, JobCancellation.idempotency_key == key
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def add(self, cancellation: JobCancellation) -> None:
        """Inserts the row now (flush): a second cancel of the job, or a key used already,
        surfaces here as an IntegrityError."""
        self._session.add(cancellation)
        await self._session.flush()
