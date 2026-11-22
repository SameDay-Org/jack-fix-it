import uuid
from collections.abc import Collection

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.web_requests.models import WebRequestContact


class WebRequestContactRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def by_key(self, key: uuid.UUID) -> WebRequestContact | None:
        statement = select(WebRequestContact).where(WebRequestContact.idempotency_key == key)
        return await self._session.scalar(statement)

    async def add(self, contact: WebRequestContact) -> None:
        """Inserts now (flush), so a key another create took surfaces here."""
        self._session.add(contact)
        await self._session.flush()

    async def of_requests(self, request_ids: Collection[uuid.UUID]) -> list[WebRequestContact]:
        if not request_ids:
            return []
        statement = select(WebRequestContact).where(WebRequestContact.request_id.in_(request_ids))
        return list((await self._session.scalars(statement)).all())
