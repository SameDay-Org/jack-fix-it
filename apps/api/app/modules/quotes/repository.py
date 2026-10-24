import uuid

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.quotes.models import Quote


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
