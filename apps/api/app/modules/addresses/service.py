"""Addresses: the only way other modules store or read an address (ADR 0003).

The caller owns the transaction: these methods flush and never commit.
"""

import uuid
from collections.abc import Collection

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.addresses.models import Address
from app.modules.addresses.repository import AddressRepository
from app.modules.addresses.schemas import AddressArea, AddressIn, AddressOut


class AddressService:
    def __init__(self, session: AsyncSession) -> None:
        self._addresses = AddressRepository(session)

    async def create(self, user_id: uuid.UUID, data: AddressIn) -> uuid.UUID:
        """Stores a new address owned by the user and returns its id."""
        address = await self._addresses.add(
            Address(
                user_id=user_id,
                line1=data.line1,
                line2=data.line2 or None,
                city=data.city,
                state=data.state,
                zip_code=data.zip_code,
            )
        )
        return address.id

    async def areas(self, address_ids: Collection[uuid.UUID]) -> dict[uuid.UUID, AddressArea]:
        """ZIP and city per address, without the street (pros before a job, #49)."""
        return {
            address_id: AddressArea(zip_code=zip_code, city=city)
            for address_id, zip_code, city in await self._addresses.areas(address_ids)
        }

    async def get(self, address_id: uuid.UUID) -> AddressOut | None:
        address = await self._addresses.get_by_id(address_id)
        if address is None:
            return None
        return AddressOut(
            line1=address.line1,
            line2=address.line2,
            city=address.city,
            state=address.state,
            zip_code=address.zip_code,
        )
