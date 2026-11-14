import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import Select, func, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.support.models import SupportTicket, TicketStatus

# Where a page starts: strictly before this (created_at, id).
Before = tuple[datetime, uuid.UUID]


@dataclass(frozen=True)
class KeyedTicket:
    """A ticket found by its Idempotency-Key, and whether it was made within the window."""

    ticket: SupportTicket
    fresh: bool


class SupportTicketRepository:
    """Queries only: support_tickets."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, ticket: SupportTicket) -> SupportTicket:
        """Inserts the ticket and reads back what Postgres set (id, status, timestamps)."""
        self._session.add(ticket)
        await self._session.flush()
        await self._session.refresh(ticket)
        return ticket

    async def by_idempotency_key(
        self, user_id: uuid.UUID, key: uuid.UUID, *, window_seconds: int
    ) -> KeyedTicket | None:
        """The user's ticket made with `key`, of any age (the unique index allows one), and
        whether it was made within the last `window_seconds` by the clock that set its
        created_at: the database's now(), which is one instant for a whole transaction, so the
        rate limit's look and the create's agree. populate_existing: read again after a racing
        create committed it."""
        fresh = SupportTicket.created_at > func.now() - timedelta(seconds=window_seconds)
        statement = (
            select(SupportTicket, fresh.label("fresh"))
            .where(SupportTicket.user_id == user_id, SupportTicket.idempotency_key == key)
            .execution_options(populate_existing=True)
        )
        found = (await self._session.execute(statement)).one_or_none()
        return None if found is None else KeyedTicket(ticket=found[0], fresh=found[1])

    async def release_idempotency_key(self, ticket: SupportTicket) -> None:
        """Clears a key older than the window from the ticket it made (loaded by
        by_idempotency_key), so a new ticket may take it. A racing create that released it
        first leaves it cleared all the same."""
        ticket.idempotency_key = None
        ticket.idempotency_fingerprint = None
        await self._session.flush()

    async def set_status(self, ticket_id: uuid.UUID, status: TicketStatus) -> SupportTicket:
        """Moves the ticket to `status` in one statement, so status and closed_at reach the
        database together (closed_at_matches_status): closed_at is the database clock while
        the ticket is closed, and cleared otherwise. Returns the ticket as written. The caller
        holds the row's lock (get_for_update)."""
        statement = (
            update(SupportTicket)
            .where(SupportTicket.id == ticket_id)
            .values(status=status, closed_at=func.now() if status == TicketStatus.CLOSED else None)
            .returning(SupportTicket)
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one()

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
