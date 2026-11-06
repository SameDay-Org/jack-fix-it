import uuid
from collections.abc import Collection
from datetime import datetime

from sqlalchemy import Select, exists, func, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.models import Job, JobEvent, JobPhoto, JobPhotoKind, JobStatus
from app.modules.media.safe_status import MediaSafeStatus


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
        limit: int,
        before: tuple[datetime, uuid.UUID] | None,
    ) -> list[Job]:
        """The pro's jobs, newest first (created_at, then id), optionally in `statuses` only,
        after the cursor `before`."""
        statement = select(Job).where(Job.pro_id == pro_id)
        if statuses is not None:
            statement = statement.where(Job.status.in_(statuses))
        if before is not None:
            statement = statement.where(tuple_(Job.created_at, Job.id) < tuple_(*before))
        statement = statement.order_by(Job.created_at.desc(), Job.id.desc()).limit(limit)
        return list((await self._session.scalars(statement)).all())

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


class JobPhotoRepository:
    """The pro's before and after photos of a job (#298)."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def of_jobs(self, job_ids: Collection[uuid.UUID]) -> list[JobPhoto]:
        """The jobs' photos, oldest first (created_at, then id)."""
        if not job_ids:
            return []
        statement = (
            select(JobPhoto)
            .where(JobPhoto.job_id.in_(job_ids))
            .order_by(JobPhoto.created_at, JobPhoto.id)
        )
        return list((await self._session.scalars(statement)).all())

    async def count(self, job_id: uuid.UUID, kind: JobPhotoKind) -> int:
        statement = select(func.count()).where(JobPhoto.job_id == job_id, JobPhoto.kind == kind)
        return int(await self._session.scalar(statement) or 0)

    async def held_keys(self, keys: Collection[str]) -> set[str]:
        """The keys among `keys` that any job photo already holds."""
        return set((await self._session.scalars(self.keys_among(keys))).all())

    async def add_all(self, photos: Collection[JobPhoto]) -> None:
        """Inserts now (flush): a key another job's photo took meanwhile fails here, on its
        unique index."""
        self._session.add_all(photos)
        await self._session.flush()

    async def pending(self, job_id: uuid.UUID) -> list[JobPhoto]:
        """The job's photos still without a safe copy, oldest first."""
        statement = (
            select(JobPhoto)
            .where(JobPhoto.job_id == job_id, JobPhoto.safe_status == MediaSafeStatus.PENDING)
            .order_by(JobPhoto.created_at, JobPhoto.id)
        )
        return list((await self._session.scalars(statement)).all())

    async def get_for_update(self, photo_id: uuid.UUID) -> JobPhoto | None:
        """One photo, locked until the transaction ends, as the last writer left it."""
        statement = (
            select(JobPhoto)
            .where(JobPhoto.id == photo_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def fail_pending(self, photo_ids: Collection[uuid.UUID]) -> list[uuid.UUID]:
        """Marks those of the photos still pending failed; the ids it changed."""
        statement = (
            update(JobPhoto)
            .where(JobPhoto.id.in_(photo_ids), JobPhoto.safe_status == MediaSafeStatus.PENDING)
            .values(safe_status=MediaSafeStatus.FAILED)
            .returning(JobPhoto.id)
            .execution_options(synchronize_session=False)
        )
        return list((await self._session.scalars(statement)).all())

    @staticmethod
    def keys_among(keys: Collection[str]) -> Select[str]:
        """The file keys among `keys` that job photos hold, for another module's query."""
        return select(JobPhoto.file_key).where(JobPhoto.file_key.in_(keys))
