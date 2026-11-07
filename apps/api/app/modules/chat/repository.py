import uuid
from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import Uuid, and_, case, func, literal, or_, select, tuple_, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.modules.chat.models import ChatOffenderFlag, JobChatRead, JobMessage, Receipt


@dataclass(frozen=True)
class MessageRow:
    message: JobMessage
    receipt: Receipt  # with the recipient: the participant who did not send it


@dataclass(frozen=True)
class FlagUpsert:
    flag_id: uuid.UUID
    created: bool  # False when an open flag was there already (its count was raised)


class ChatRepository:
    """Queries only: job_messages and job_chat_reads (#71), chat_offender_flags (#72)."""

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
        (customer, pro user) who did not send it. One query: a join on the recipient's marker
        row (at most one: (job_id, user_id) is unique)."""
        customer_id, pro_user_id = parties
        recipient = aliased(JobChatRead)
        recipient_id = case(
            (JobMessage.sender_id == customer_id, literal(pro_user_id, Uuid)),
            else_=literal(customer_id, Uuid),
        )
        position = tuple_(JobMessage.created_at, JobMessage.id)
        # A missing marker (no row, or read still NULL) compares as NULL: the case moves on.
        receipt = case(
            (
                tuple_(recipient.last_read_message_at, recipient.last_read_message_id) >= position,
                literal(Receipt.SEEN.value),
            ),
            (
                tuple_(recipient.last_delivered_message_at, recipient.last_delivered_message_id)
                >= position,
                literal(Receipt.DELIVERED.value),
            ),
            else_=literal(Receipt.SENT.value),
        )
        statement = (
            select(JobMessage, receipt)
            .outerjoin(
                recipient,
                and_(recipient.job_id == JobMessage.job_id, recipient.user_id == recipient_id),
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
        """Sets the user's read marker on the job to `message`, only forward, and their
        delivered marker to it too unless that one is further already (reading implies
        delivered). One statement, so two concurrent calls cannot move either back (the later
        message wins)."""
        statement = insert(JobChatRead).values(
            job_id=job_id,
            user_id=user_id,
            last_read_message_id=message.id,
            last_read_message_at=message.created_at,
            last_delivered_message_id=message.id,
            last_delivered_message_at=message.created_at,
        )
        new = statement.excluded
        read = tuple_(JobChatRead.last_read_message_at, JobChatRead.last_read_message_id)
        delivered_ahead = tuple_(
            JobChatRead.last_delivered_message_at, JobChatRead.last_delivered_message_id
        ) > tuple_(new.last_delivered_message_at, new.last_delivered_message_id)
        statement = statement.on_conflict_do_update(
            index_elements=[JobChatRead.job_id, JobChatRead.user_id],
            set_={
                "last_read_message_id": new.last_read_message_id,
                "last_read_message_at": new.last_read_message_at,
                # Both from the row as it was: they move together or not at all.
                "last_delivered_message_id": case(
                    (delivered_ahead, JobChatRead.last_delivered_message_id),
                    else_=new.last_delivered_message_id,
                ),
                "last_delivered_message_at": case(
                    (delivered_ahead, JobChatRead.last_delivered_message_at),
                    else_=new.last_delivered_message_at,
                ),
                "updated_at": func.now(),
            },
            # No read marker yet (a row made by listing), or an older one.
            where=or_(
                JobChatRead.last_read_message_at.is_(None),
                read < tuple_(new.last_read_message_at, new.last_read_message_id),
            ),
        )
        await self._session.execute(statement)

    async def move_delivered(
        self, job_id: uuid.UUID, user_id: uuid.UUID, message: JobMessage
    ) -> None:
        """Sets the user's delivered marker on the job to `message`, only forward (the read
        marker is left as it is). One statement, like move_read."""
        statement = insert(JobChatRead).values(
            job_id=job_id,
            user_id=user_id,
            last_delivered_message_id=message.id,
            last_delivered_message_at=message.created_at,
        )
        new = statement.excluded
        statement = statement.on_conflict_do_update(
            index_elements=[JobChatRead.job_id, JobChatRead.user_id],
            set_={
                "last_delivered_message_id": new.last_delivered_message_id,
                "last_delivered_message_at": new.last_delivered_message_at,
                "updated_at": func.now(),
            },
            where=tuple_(
                JobChatRead.last_delivered_message_at, JobChatRead.last_delivered_message_id
            )
            < tuple_(new.last_delivered_message_at, new.last_delivered_message_id),
        )
        await self._session.execute(statement)

    async def unread_counts(
        self, job_ids: Collection[uuid.UUID], user_id: uuid.UUID
    ) -> dict[uuid.UUID, int]:
        """Per job: the messages others sent after the user's read marker (all of them without
        one: no row, or a row with a delivered marker only). Jobs with none are absent. One
        query."""
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
                    marker.last_read_message_at.is_(None),
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
