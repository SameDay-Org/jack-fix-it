import uuid
from collections.abc import Collection

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.addresses.models import Address


class AddressRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, address: Address) -> Address:
        self._session.add(address)
        await self._session.flush()
        return address

    async def get_by_id(self, address_id: uuid.UUID) -> Address | None:
        return await self._session.get(Address, address_id)

    async def areas(self, address_ids: Collection[uuid.UUID]) -> list[tuple[uuid.UUID, str, str]]:
        """(id, zip_code, city) only: the street is never loaded."""
        if not address_ids:
            return []
        statement = select(Address.id, Address.zip_code, Address.city).where(
            Address.id.in_(address_ids)
        )
        return [(row[0], row[1], row[2]) for row in (await self._session.execute(statement)).all()]

    async def street_lines(
        self, address_ids: Collection[uuid.UUID]
    ) -> list[tuple[uuid.UUID, str, str | None]]:
        """(id, line1, line2): the street and the unit, for masking them in text (#172)."""
        if not address_ids:
            return []
        statement = select(Address.id, Address.line1, Address.line2).where(
            Address.id.in_(address_ids)
        )
        return [(row[0], row[1], row[2]) for row in (await self._session.execute(statement)).all()]
