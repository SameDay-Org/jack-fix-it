import uuid
from datetime import datetime

from sqlalchemy import and_, exists, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.quotes.models import Quote, QuoteStatus


class QuoteRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def exists_for(self, request_id: uuid.UUID, pro_id: uuid.UUID) -> bool:
        statement = select(exists().where(Quote.request_id == request_id, Quote.pro_id == pro_id))
        return bool(await self._session.scalar(statement))

    async def open_of_request(self, request_id: uuid.UUID, now: datetime) -> list[Quote]:
        """The request's accepted quote and its pending ones still before expires_at (whether
        or not the expiry worker has marked them yet), cheapest first, then oldest, then by id."""
        statement = (
            select(Quote)
            .where(
                Quote.request_id == request_id,
                or_(
                    Quote.status == QuoteStatus.ACCEPTED,
                    and_(Quote.status == QuoteStatus.PENDING, Quote.expires_at > now),
                ),
            )
            .order_by(Quote.amount_cents, Quote.created_at, Quote.id)
        )
        return list((await self._session.scalars(statement)).all())

    async def get_of_request_for_update(
        self, quote_id: uuid.UUID, request_id: uuid.UUID
    ) -> Quote | None:
        """The quote, locked until the transaction ends; None when it is not a quote of this
        request. Take the request's lock first. populate_existing: a waiter gets the row as the
        transaction that held the lock left it."""
        statement = (
            select(Quote)
            .where(Quote.id == quote_id, Quote.request_id == request_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def mark_accepted(self, quote_id: uuid.UUID) -> bool:
        """pending -> accepted; a conditional UPDATE, so it happens once, and it leaves nothing
        pending for the request's transition that follows (the session's copy of the quote is
        synchronized, not made dirty). False when the quote was no longer pending."""
        statement = (
            update(Quote)
            .where(Quote.id == quote_id, Quote.status == QuoteStatus.PENDING)
            .values(status=QuoteStatus.ACCEPTED)
            .returning(Quote.id)
        )
        return (await self._session.scalar(statement)) is not None

    async def add(self, quote: Quote) -> Quote:
        """Inserts now (flush): a second quote by the pro on the request fails here, on the
        UNIQUE (request_id, pro_id), and the database sets id, status and timestamps."""
        self._session.add(quote)
        await self._session.flush()
        await self._session.refresh(quote)
        return quote
