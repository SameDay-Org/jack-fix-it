import uuid
from datetime import datetime

from sqlalchemy import exists, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.quotes.models import Quote, QuoteStatus


class QuoteRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def exists_for(self, request_id: uuid.UUID, pro_id: uuid.UUID) -> bool:
        statement = select(exists().where(Quote.request_id == request_id, Quote.pro_id == pro_id))
        return bool(await self._session.scalar(statement))

    async def add(self, quote: Quote) -> Quote:
        """Inserts now (flush): a second quote by the pro on the request fails here, on the
        UNIQUE (request_id, pro_id), and the database sets id, status and timestamps."""
        self._session.add(quote)
        await self._session.flush()
        await self._session.refresh(quote)
        return quote

    async def requests_with_due_quotes(
        self, now: datetime, after: uuid.UUID | None, limit: int
    ) -> list[uuid.UUID]:
        """The requests with a pending quote whose expires_at is `now` or earlier, by id, after
        `after` (a keyset: each one comes up once per sweep). Nothing is locked."""
        due = [Quote.status == QuoteStatus.PENDING, Quote.expires_at <= now]
        if after is not None:
            due.append(Quote.request_id > after)
        statement = (
            select(Quote.request_id)
            .where(*due)
            .group_by(Quote.request_id)
            .order_by(Quote.request_id)
            .limit(limit)
        )
        return list((await self._session.scalars(statement)).all())

    async def expire_due(self, request_id: uuid.UUID, now: datetime) -> list[uuid.UUID]:
        """pending -> expired for the request's quotes whose expires_at is `now` or earlier; a
        conditional UPDATE, so a quote accepted or expired meanwhile is left as it is. Take the
        request's lock first. The ids of the quotes it expired, in id order."""
        statement = (
            update(Quote)
            .where(
                Quote.request_id == request_id,
                Quote.status == QuoteStatus.PENDING,
                Quote.expires_at <= now,
            )
            .values(status=QuoteStatus.EXPIRED)
            .returning(Quote.id)
        )
        return sorted((await self._session.scalars(statement)).all())

    async def has_live(self, request_id: uuid.UUID) -> bool:
        """Whether the request still has a pending or an accepted quote."""
        statement = select(
            exists().where(
                Quote.request_id == request_id,
                Quote.status.in_([QuoteStatus.PENDING, QuoteStatus.ACCEPTED]),
            )
        )
        return bool(await self._session.scalar(statement))
