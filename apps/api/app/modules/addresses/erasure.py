"""The addresses' part of an account deletion (#97): the address book goes; each request's own
address (a snapshot a request and its job point at) loses its street and its point, and keeps
its city, state and ZIP (#395's rule: no identifiable point is left)."""

import uuid
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.addresses.repository import AddressRepository, SavedAddressRepository
from app.modules.users.types import ERASED_TEXT


@dataclass(frozen=True)
class ErasedAddresses:
    saved_deleted: int
    request_addresses_erased: int


class AddressErasure:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._addresses = AddressRepository(session)
        self._saved = SavedAddressRepository(session)

    async def erase(self, user_id: uuid.UUID) -> ErasedAddresses:
        # The address book's own lock first, as every change to it takes.
        await self._saved.lock_user(user_id)
        saved = await self._saved.delete_saved_for_user(user_id)
        erased = await self._addresses.erase_for_user(user_id, ERASED_TEXT)
        return ErasedAddresses(saved_deleted=saved, request_addresses_erased=erased)
