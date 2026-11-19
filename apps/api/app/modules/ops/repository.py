"""The BDC's own tables (#82): request_notes and request_followups. Other modules never read
them (ADR 0003); the ops services do."""

import uuid
from datetime import datetime

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.ops.models import RequestFollowup, RequestNote


class NoteRepository:
    """Notes are appended: there is no method that changes or deletes one."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, note: RequestNote) -> RequestNote:
        self._session.add(note)
        await self._session.flush()
        await self._session.refresh(note)
        return note

    async def of_request(self, request_id: uuid.UUID) -> list[RequestNote]:
        """The request's notes, oldest first."""
        statement = (
            select(RequestNote)
            .where(RequestNote.request_id == request_id)
            .order_by(RequestNote.created_at, RequestNote.id)
        )
        return list((await self._session.scalars(statement)).all())


class FollowupRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, followup: RequestFollowup) -> RequestFollowup:
        self._session.add(followup)
        await self._session.flush()
        await self._session.refresh(followup)
        return followup

    async def for_update(self, followup_id: uuid.UUID) -> RequestFollowup | None:
        """The follow-up, locked until the transaction ends, read as last committed."""
        statement = (
            select(RequestFollowup)
            .where(RequestFollowup.id == followup_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def mark_done(self, followup_id: uuid.UUID, by: uuid.UUID, at: datetime) -> bool:
        """Done once: False (nothing written) when it was done already."""
        statement = (
            update(RequestFollowup)
            .where(RequestFollowup.id == followup_id, RequestFollowup.done_at.is_(None))
            .values(done_at=at, done_by=by)
            .returning(RequestFollowup.id)
        )
        return (await self._session.scalar(statement)) is not None

    async def of_request(self, request_id: uuid.UUID) -> list[RequestFollowup]:
        """The request's follow-ups, by due time."""
        statement = (
            select(RequestFollowup)
            .where(RequestFollowup.request_id == request_id)
            .order_by(RequestFollowup.due_at, RequestFollowup.id)
            .execution_options(populate_existing=True)
        )
        return list((await self._session.scalars(statement)).all())

    async def count_open_due(self, assigned_to: uuid.UUID, due_before: datetime) -> int:
        """How many of the staff member's follow-ups not done are due before `due_before`."""
        statement = select(func.count()).where(
            RequestFollowup.assigned_to == assigned_to,
            RequestFollowup.done_at.is_(None),
            RequestFollowup.due_at < due_before,
        )
        return int(await self._session.scalar(statement) or 0)

    async def open_due(
        self,
        assigned_to: uuid.UUID,
        due_before: datetime | None,
        after: tuple[datetime, uuid.UUID] | None,
        limit: int,
    ) -> list[RequestFollowup]:
        """The staff member's follow-ups not done, due before `due_before` (None: any time),
        by due time then id, after the cursor's (due_at, id) when given; at most `limit`."""
        statement = select(RequestFollowup).where(
            RequestFollowup.assigned_to == assigned_to, RequestFollowup.done_at.is_(None)
        )
        if due_before is not None:
            statement = statement.where(RequestFollowup.due_at < due_before)
        if after is not None:
            due_at, followup_id = after
            statement = statement.where(
                or_(
                    RequestFollowup.due_at > due_at,
                    and_(RequestFollowup.due_at == due_at, RequestFollowup.id > followup_id),
                )
            )
        statement = statement.order_by(RequestFollowup.due_at, RequestFollowup.id).limit(limit)
        return list((await self._session.scalars(statement)).all())
