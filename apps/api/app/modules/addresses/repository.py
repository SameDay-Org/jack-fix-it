import uuid

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
