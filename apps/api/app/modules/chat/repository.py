import uuid
from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import Uuid, and_, case, func, literal, or_, select, tuple_, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.modules.chat.models import (
    ChatOffenderFlag,
    JobChatDelivery,
    JobChatRead,
    JobMessage,
    Receipt,
)


@dataclass(frozen=True)
class MessageRow:
    message: JobMessage
    receipt: Receipt  # with the recipient: the participant who did not send it


@dataclass(frozen=True)
class FlagUpsert:
    flag_id: uuid.UUID
    created: bool  # False when an open flag was there already (its count was raised)


class ChatRepository:
    """Queries only: job_messages and job_chat_reads (#71), chat_offender_flags (#72),
    job_chat_deliveries (#331)."""

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
        self,
        job_id: uuid.UUID,
        parties: tuple[uuid.UUID, uuid.UUID],
        limit: int,
        before: tuple[datetime, uuid.UUID] | None,
    ) -> list[MessageRow]:
        """The job's messages newest first (created_at, then id), after the cursor `before`,
        each with its receipt: how far it got with its recipient, the one of the two `parties`
        (customer, pro user) who did not send it. One query: a join on each of the recipient's
        marker rows (at most one each: (job_id, user_id) is unique)."""
        customer_id, pro_user_id = parties
        read = aliased(JobChatRead)
        delivery = aliased(JobChatDelivery)
        recipient_id = case(
            (JobMessage.sender_id == customer_id, literal(pro_user_id, Uuid)),
            else_=literal(customer_id, Uuid),
        )
        position = tuple_(JobMessage.created_at, JobMessage.id)
        # Read first: reading implies delivered, whatever the delivered marker says. A missing
        # marker row compares as NULL: the case moves on.
        receipt = case(
            (
                tuple_(read.last_read_message_at, read.last_read_message_id) >= position,
                literal(Receipt.SEEN.value),
            ),
            (
                tuple_(delivery.last_delivered_message_at, delivery.last_delivered_message_id)
                >= position,
                literal(Receipt.DELIVERED.value),
            ),
            else_=literal(Receipt.SENT.value),
        )
        statement = (
            select(JobMessage, receipt)
            .outerjoin(read, and_(read.job_id == JobMessage.job_id, read.user_id == recipient_id))
            .outerjoin(
                delivery,
                and_(delivery.job_id == JobMessage.job_id, delivery.user_id == recipient_id),
            )
            .where(JobMessage.job_id == job_id)
        )
        if before is not None:
            statement = statement.where(position < tuple_(*before))
        statement = statement.order_by(JobMessage.created_at.desc(), JobMessage.id.desc())
        result = await self._session.execute(statement.limit(limit))
        return [MessageRow(message, Receipt(value)) for message, value in result]

    async def get_in_job(self, job_id: uuid.UUID, message_id: uuid.UUID) -> JobMessage | None:
        """The message, only when it belongs to the job."""
        statement = select(JobMessage).where(
            JobMessage.id == message_id, JobMessage.job_id == job_id
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def move_read(self, job_id: uuid.UUID, user_id: uuid.UUID, message: JobMessage) -> None:
        """Sets the user's read marker on the job to `message`, only forward: one statement, so
        two concurrent calls cannot move it back (the later message wins). The delivered marker
        is left as it is: a read message counts as delivered from this marker (`page`)."""
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

    async def move_delivered(
        self, job_id: uuid.UUID, user_id: uuid.UUID, message: JobMessage
    ) -> None:
        """Sets the user's delivered marker on the job to `message`, only forward (the read
        marker is left as it is). One statement, like move_read."""
        statement = insert(JobChatDelivery).values(
            job_id=job_id,
            user_id=user_id,
            last_delivered_message_id=message.id,
            last_delivered_message_at=message.created_at,
        )
        new = statement.excluded
        statement = statement.on_conflict_do_update(
            index_elements=[JobChatDelivery.job_id, JobChatDelivery.user_id],
            set_={
                "last_delivered_message_id": new.last_delivered_message_id,
                "last_delivered_message_at": new.last_delivered_message_at,
                "updated_at": func.now(),
            },
            where=tuple_(
                JobChatDelivery.last_delivered_message_at,
                JobChatDelivery.last_delivered_message_id,
            )
            < tuple_(new.last_delivered_message_at, new.last_delivered_message_id),
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

    async def redacted_since(self, sender_id: uuid.UUID, window_seconds: int) -> int:
        """The sender's redacted messages, in every job, created within the last
        `window_seconds` by the database clock (strictly: one exactly that old is out)."""
        since = func.clock_timestamp() - func.make_interval(0, 0, 0, 0, 0, 0, window_seconds)
        statement = (
            select(func.count())
            .select_from(JobMessage)
            .where(
                JobMessage.sender_id == sender_id,
                JobMessage.redacted.is_(True),
                JobMessage.created_at > since,
            )
        )
        return int(await self._session.scalar(statement) or 0)

    async def raise_flag(self, user_id: uuid.UUID, job_id: uuid.UUID, count: int) -> FlagUpsert:
        """Raises the user's open flag to `count` (never lowers it), or opens one. Safe under
        concurrency: an insert that meets another's open flag (the partial unique index) does
        nothing, having waited for it to commit, and the update after it raises that flag."""
        open_flag = ChatOffenderFlag.user_id == user_id, ChatOffenderFlag.resolved_at.is_(None)
        raise_count = (
            update(ChatOffenderFlag)
            .where(*open_flag)
            .values(
                window_count=func.greatest(ChatOffenderFlag.window_count, count),
                updated_at=func.now(),
            )
            .returning(ChatOffenderFlag.id)
        )
        if (flag_id := await self._session.scalar(raise_count)) is not None:
            return FlagUpsert(flag_id=flag_id, created=False)
        opened = (
            insert(ChatOffenderFlag)
            .values(user_id=user_id, job_id=job_id, window_count=count)
            .on_conflict_do_nothing(
                index_elements=[ChatOffenderFlag.user_id],
                index_where=ChatOffenderFlag.resolved_at.is_(None),
            )
            .returning(ChatOffenderFlag.id)
        )
        if (flag_id := await self._session.scalar(opened)) is not None:
            return FlagUpsert(flag_id=flag_id, created=True)
        flag_id = await self._session.scalar(raise_count)
        if flag_id is None:  # opened by another transaction and resolved in between
            raise RuntimeError("chat offender flag vanished")
        return FlagUpsert(flag_id=flag_id, created=False)

    async def flags(
        self, *, open_only: bool, limit: int, before: tuple[datetime, uuid.UUID] | None
    ) -> list[ChatOffenderFlag]:
        """Open (or resolved) flags newest first by (created_at, id), after the cursor."""
        resolved = ChatOffenderFlag.resolved_at
        statement = select(ChatOffenderFlag).where(
            resolved.is_(None) if open_only else resolved.is_not(None)
        )
        if before is not None:
            statement = statement.where(
                tuple_(ChatOffenderFlag.created_at, ChatOffenderFlag.id) < tuple_(*before)
            )
        statement = statement.order_by(
            ChatOffenderFlag.created_at.desc(), ChatOffenderFlag.id.desc()
        )
        return list((await self._session.scalars(statement.limit(limit))).all())

    async def clear_expired_originals(self, now: datetime, limit: int) -> int:
        """Clears the originals of at most `limit` messages whose original_expires_at is at or
        before `now`, skipping rows another transaction holds; how many it cleared."""
        due = (
            select(JobMessage.id)
            .where(JobMessage.original_expires_at <= now)
            .order_by(JobMessage.original_expires_at)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        statement = (
            update(JobMessage)
            .where(JobMessage.id.in_(due.scalar_subquery()))
            .values(
                original_ciphertext=None,
                original_key_id=None,
                original_expires_at=None,
                updated_at=func.now(),
            )
            .execution_options(synchronize_session=False)
        )
        result = await self._session.execute(statement)
        return int(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of an UPDATE
