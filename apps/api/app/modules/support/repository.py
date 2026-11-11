import uuid
from datetime import datetime

from sqlalchemy import Select, func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.support.models import SupportTicket, TicketStatus

# Where a page starts: strictly before this (created_at, id).
Before = tuple[datetime, uuid.UUID]


class SupportTicketRepository:
    """Queries only: support_tickets."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def now(self) -> datetime:
        """The database clock: `closed_at` and `created_at` come from the same clock."""
        return (await self._session.execute(select(func.now()))).scalar_one()

    async def add(self, ticket: SupportTicket) -> SupportTicket:
        """Inserts the ticket and reads back what Postgres set (id, status, timestamps)."""
        self._session.add(ticket)
        await self._session.flush()
        await self._session.refresh(ticket)
        return ticket

    async def save(self, ticket: SupportTicket) -> None:
        """Writes the ticket's changes now and reads back what Postgres set (updated_at)."""
        await self._session.flush()
        await self._session.refresh(ticket)

    async def get(self, ticket_id: uuid.UUID) -> SupportTicket | None:
        return await self._session.get(SupportTicket, ticket_id)

    async def get_for_update(self, ticket_id: uuid.UUID) -> SupportTicket | None:
        """The ticket as last committed, its row locked until the caller's transaction ends:
        two staff changing one ticket run one after the other."""
        statement = (
            select(SupportTicket)
            .where(SupportTicket.id == ticket_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def page_of_user(
        self, user_id: uuid.UUID, *, limit: int, before: Before | None
    ) -> list[SupportTicket]:
        """One user's tickets, newest first by (created_at, id), after the cursor. The user is
        always part of the statement: a cursor only positions the page inside their own."""
        statement = select(SupportTicket).where(SupportTicket.user_id == user_id)
        return await self._page(statement, limit, before)

    async def page(
        self, *, status: TicketStatus | None, limit: int, before: Before | None
    ) -> list[SupportTicket]:
        """Everyone's tickets for staff, newest first: one status, or all of them (None)."""
        statement = select(SupportTicket)
        if status is not None:
            statement = statement.where(SupportTicket.status == status)
        return await self._page(statement, limit, before)

    async def _page(
        self, statement: Select[SupportTicket], limit: int, before: Before | None
    ) -> list[SupportTicket]:
        if before is not None:
            statement = statement.where(
                tuple_(SupportTicket.created_at, SupportTicket.id) < tuple_(*before)
            )
        statement = statement.order_by(SupportTicket.created_at.desc(), SupportTicket.id.desc())
        return list((await self._session.scalars(statement.limit(limit))).all())
