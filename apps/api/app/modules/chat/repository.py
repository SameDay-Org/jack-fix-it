import uuid
from collections.abc import Collection
from datetime import datetime

from sqlalchemy import and_, func, or_, select, tuple_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.chat.models import JobChatRead, JobMessage


class ChatRepository:
    """Queries only: job_messages and job_chat_reads (#71)."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def now(self) -> datetime:
        """The database clock now (clock_timestamp), not the transaction's start time."""
        now: datetime = (await self._session.execute(select(func.clock_timestamp()))).scalar_one()
        return now

    async def add(self, message: JobMessage) -> JobMessage:
        """Inserts now (flush)."""
        self._session.add(message)
        await self._session.flush()
        return message

    async def page(
        self, job_id: uuid.UUID, limit: int, before: tuple[datetime, uuid.UUID] | None
    ) -> list[JobMessage]:
        """The job's messages newest first (created_at, then id), after the cursor `before`."""
        statement = select(JobMessage).where(JobMessage.job_id == job_id)
        if before is not None:
            statement = statement.where(
                tuple_(JobMessage.created_at, JobMessage.id) < tuple_(*before)
            )
        statement = statement.order_by(JobMessage.created_at.desc(), JobMessage.id.desc())
        return list((await self._session.scalars(statement.limit(limit))).all())

    async def get_in_job(self, job_id: uuid.UUID, message_id: uuid.UUID) -> JobMessage | None:
        """The message, only when it belongs to the job."""
        statement = select(JobMessage).where(
            JobMessage.id == message_id, JobMessage.job_id == job_id
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def move_marker(self, job_id: uuid.UUID, user_id: uuid.UUID, message: JobMessage) -> None:
        """Sets the user's read marker on the job to `message`, only forward: one statement, so
        two concurrent calls cannot move it back (the later message wins)."""
        statement = insert(JobChatRead).values(
            job_id=job_id,
            user_id=user_id,
            last_read_message_id=message.id,
            last_read_message_at=message.created_at,
        )
        statement = statement.on_conflict_do_update(
            index_elements=[JobChatRead.job_id, JobChatRead.user_id],
            set_={
                "last_read_message_id": statement.excluded.last_read_message_id,
                "last_read_message_at": statement.excluded.last_read_message_at,
                "updated_at": func.now(),
            },
            where=tuple_(JobChatRead.last_read_message_at, JobChatRead.last_read_message_id)
            < tuple_(
                statement.excluded.last_read_message_at, statement.excluded.last_read_message_id
            ),
        )
        await self._session.execute(statement)

    async def unread_counts(
        self, job_ids: Collection[uuid.UUID], user_id: uuid.UUID
    ) -> dict[uuid.UUID, int]:
        """Per job: the messages others sent after the user's read marker (all of them without
        one). Jobs with none are absent. One query."""
        if not job_ids:
            return {}
        marker = JobChatRead
        statement = (
            select(JobMessage.job_id, func.count())
            .select_from(JobMessage)
            .outerjoin(marker, and_(marker.job_id == JobMessage.job_id, marker.user_id == user_id))
            .where(
                JobMessage.job_id.in_(job_ids),
                JobMessage.sender_id != user_id,
                or_(
                    marker.id.is_(None),
                    tuple_(JobMessage.created_at, JobMessage.id)
                    > tuple_(marker.last_read_message_at, marker.last_read_message_id),
                ),
            )
            .group_by(JobMessage.job_id)
        )
        return {job_id: count for job_id, count in await self._session.execute(statement)}
