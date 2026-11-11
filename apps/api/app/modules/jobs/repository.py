import uuid
from collections.abc import Collection
from datetime import datetime

from sqlalchemy import Select, Subquery, exists, func, or_, select, tuple_, update
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

    async def get_of_request_for_update(self, request_id: uuid.UUID) -> Job | None:
        """The request's job, locked as get_for_update locks it."""
        statement = (
            select(Job)
            .where(Job.request_id == request_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def get_for_no_key_update(self, job_id: uuid.UUID) -> Job | None:
        """The job, locked FOR NO KEY UPDATE until the transaction ends: it waits for, and
        holds off, get_for_update (every status change), and two such locks on the job wait for
        each other, while inserts referencing the job (events, photos) never wait on it.

        populate_existing: a waiter gets the row as the transaction that held the lock left it.
        """
        statement = (
            select(Job)
            .where(Job.id == job_id)
            .with_for_update(key_share=True)
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def completed_before(
        self, completed_before: datetime, after: uuid.UUID | None, limit: int
    ) -> list[uuid.UUID]:
        """Up to `limit` ids of the jobs still completed whose completed_at is at or before
        `completed_before`, by id, after the id `after`: the auto-confirm sweep's batches (#67).
        Unlocked: each is checked again under its lock."""
        statement = select(Job.id).where(
            Job.status == JobStatus.COMPLETED, Job.completed_at <= completed_before
        )
        if after is not None:
            statement = statement.where(Job.id > after)
        statement = statement.order_by(Job.id).limit(limit)
        return list((await self._session.scalars(statement)).all())

    async def get_of_request(self, request_id: uuid.UUID) -> Job | None:
        """The request's job (one per request), unlocked: for reads."""
        return (
            await self._session.scalars(select(Job).where(Job.request_id == request_id))
        ).one_or_none()

    async def get(self, job_id: uuid.UUID) -> Job | None:
        """The job, unlocked: for reads."""
        return await self._session.get(Job, job_id)

    async def get_with_pro_user(
        self, job_id: uuid.UUID, pros: Subquery, *, participant: uuid.UUID | None, lock: bool
    ) -> tuple[Job, uuid.UUID] | None:
        """The job with its pro's user id (`pros`: `pro_id`, `user_id`), in one statement.
        With `participant`, only when they take part (the customer or the pro's user): a job of
        others is None like an unknown id, through the same statement. With `lock`, the job row
        is held as get_for_no_key_update holds it (the pros' rows are not locked)."""
        statement = (
            select(Job, pros.c.user_id)
            .join(pros, pros.c.pro_id == Job.pro_id)
            .where(Job.id == job_id)
        )
        if participant is not None:
            statement = statement.where(
                or_(Job.customer_id == participant, pros.c.user_id == participant)
            )
        if lock:
            statement = statement.with_for_update(key_share=True, of=Job).execution_options(
                populate_existing=True
            )
        row = (await self._session.execute(statement)).one_or_none()
        if row is None:
            return None
        job, pro_user_id = row
        return job, pro_user_id

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

    async def count_by_status(
        self, job_id: uuid.UUID, kind: JobPhotoKind
    ) -> dict[MediaSafeStatus, int]:
        """How many of the job's photos of the kind are in each safe-copy status (every status
        present, zero when none)."""
        statement = (
            select(JobPhoto.safe_status, func.count())
            .where(JobPhoto.job_id == job_id, JobPhoto.kind == kind)
            .group_by(JobPhoto.safe_status)
        )
        counts = dict.fromkeys(MediaSafeStatus, 0)
        for status, count in (await self._session.execute(statement)).tuples():
            counts[status] = count
        return counts

    async def statuses(
        self, job_id: uuid.UUID, kind: JobPhotoKind
    ) -> list[tuple[uuid.UUID, MediaSafeStatus]]:
        """Each of the job's photos of the kind with its safe-copy status, oldest first, in one
        query: one snapshot, so a copy the worker settles meanwhile cannot split the answer."""
        statement = (
            select(JobPhoto.id, JobPhoto.safe_status)
            .where(JobPhoto.job_id == job_id, JobPhoto.kind == kind)
            .order_by(JobPhoto.created_at, JobPhoto.id)
        )
        return [(photo_id, status) for photo_id, status in await self._session.execute(statement)]

    async def held_keys(self, keys: Collection[str]) -> set[str]:
        """The keys among `keys` that any job photo already holds."""
        return set((await self._session.scalars(self.keys_among(keys))).all())

    async def add_all(self, photos: Collection[JobPhoto]) -> None:
        """Inserts now (flush): a key another job's photo took meanwhile fails here, on its
        unique index."""
        self._session.add_all(photos)
        await self._session.flush()

    async def pending(self, job_id: uuid.UUID, photo_ids: Collection[uuid.UUID]) -> list[JobPhoto]:
        """Those of the job's photos `photo_ids` still without a safe copy, oldest first."""
        statement = (
            select(JobPhoto)
            .where(
                JobPhoto.job_id == job_id,
                JobPhoto.id.in_(photo_ids),
                JobPhoto.safe_status == MediaSafeStatus.PENDING,
            )
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
