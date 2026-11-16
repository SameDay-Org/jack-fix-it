import uuid
from collections.abc import Collection
from decimal import Decimal

from sqlalchemy import func, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.addresses.models import Address, SavedAddress

# An address has its point when both halves are there (AddressService.place reads it so).
_WITHOUT_POINT = or_(Address.lat.is_(None), Address.lng.is_(None))


class AddressRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, address: Address) -> Address:
        self._session.add(address)
        await self._session.flush()
        return address

    async def get_by_id(self, address_id: uuid.UUID) -> Address | None:
        return await self._session.get(Address, address_id)

    async def zip_codes(self, address_ids: Collection[uuid.UUID]) -> list[tuple[uuid.UUID, str]]:
        """(id, zip_code) only: neither the street nor the city the customer typed is loaded."""
        if not address_ids:
            return []
        statement = select(Address.id, Address.zip_code).where(Address.id.in_(address_ids))
        return [(row[0], row[1]) for row in (await self._session.execute(statement)).all()]

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

    async def get_many(self, address_ids: Collection[uuid.UUID]) -> list[Address]:
        if not address_ids:
            return []
        statement = select(Address).where(Address.id.in_(address_ids))
        return list((await self._session.scalars(statement)).all())

    async def place_to_geocode(
        self, address_id: uuid.UUID
    ) -> tuple[str, str, str, str, bool] | None:
        """(line1, city, state, zip_code, without a point) as the database has them now,
        whatever the session remembers of the row. The unit line is not loaded."""
        statement = select(
            Address.line1, Address.city, Address.state, Address.zip_code, _WITHOUT_POINT
        ).where(Address.id == address_id)
        row = (await self._session.execute(statement)).one_or_none()
        return None if row is None else (row[0], row[1], row[2], row[3], bool(row[4]))

    async def set_point(
        self,
        address_id: uuid.UUID,
        *,
        line1: str,
        city: str,
        state: str,
        zip_code: str,
        lat: Decimal,
        lng: Decimal,
    ) -> bool:
        """Gives the address its point (#384). Only a row that has none and still reads as
        the text the point was found for: False, and nothing written, for any other. The one
        statement that updates an address (tests/test_address_geocode_guard.py)."""
        result = await self._session.execute(
            update(Address)
            .where(
                Address.id == address_id,
                _WITHOUT_POINT,
                Address.line1 == line1,
                Address.city == city,
                Address.state == state,
                Address.zip_code == zip_code,
            )
            .values(lat=lat, lng=lng)
        )
        return bool(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of an UPDATE

    async def count_without_point(self) -> int:
        statement = select(func.count()).select_from(Address).where(_WITHOUT_POINT)
        return int(await self._session.scalar(statement) or 0)

    async def ids_without_point(self, *, after: uuid.UUID | None, limit: int) -> list[uuid.UUID]:
        """The ids only, in id order past `after`: no street is loaded to page through them."""
        statement = select(Address.id).where(_WITHOUT_POINT).order_by(Address.id).limit(limit)
        if after is not None:
            statement = statement.where(Address.id > after)
        return list((await self._session.scalars(statement)).all())


class SavedAddressRepository:
    """The customer's address book (#214). Every row read for a change is read as last
    committed (populate_existing), after the user's lock was taken."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def lock_user(self, user_id: uuid.UUID) -> None:
        """Transaction-scoped lock serializing every change to one user's saved addresses, so
        a count, a label check and a move of the default see the previous change committed."""
        await self._session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"saved-addresses:{user_id}"},
        )

    async def count_for_user(self, user_id: uuid.UUID) -> int:
        statement = (
            select(func.count()).select_from(SavedAddress).where(SavedAddress.user_id == user_id)
        )
        return int(await self._session.scalar(statement) or 0)

    async def list_for_user(self, user_id: uuid.UUID) -> list[SavedAddress]:
        """The default first, then the oldest first (the id breaks a tie)."""
        statement = (
            select(SavedAddress)
            .where(SavedAddress.user_id == user_id)
            .order_by(SavedAddress.is_default.desc(), SavedAddress.created_at, SavedAddress.id)
        )
        return list((await self._session.scalars(statement)).all())

    async def get_own(self, user_id: uuid.UUID, address_id: uuid.UUID) -> SavedAddress | None:
        """The user's own address with this id; None for anyone else's or an unknown one."""
        statement = (
            select(SavedAddress)
            .where(SavedAddress.id == address_id, SavedAddress.user_id == user_id)
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def label_taken(
        self, user_id: uuid.UUID, label: str, *, except_id: uuid.UUID | None = None
    ) -> bool:
        """Whether one of the user's other addresses has this label, compared as the unique
        index compares them: Postgres lowercases both sides."""
        statement = select(SavedAddress.id).where(
            SavedAddress.user_id == user_id,
            func.lower(SavedAddress.label) == func.lower(label),
        )
        if except_id is not None:
            statement = statement.where(SavedAddress.id != except_id)
        return (await self._session.scalar(statement)) is not None

    async def clear_default(self, user_id: uuid.UUID) -> None:
        """No address of the user is the default any more. The caller sets the new one after
        this statement: the partial unique index is checked per statement, never deferred."""
        await self._session.execute(
            update(SavedAddress)
            .where(SavedAddress.user_id == user_id, SavedAddress.is_default)
            .values(is_default=False)
        )

    async def oldest_for_user(self, user_id: uuid.UUID) -> SavedAddress | None:
        statement = (
            select(SavedAddress)
            .where(SavedAddress.user_id == user_id)
            .order_by(SavedAddress.created_at, SavedAddress.id)
            .limit(1)
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def add(self, address: SavedAddress) -> SavedAddress:
        self._session.add(address)
        await self._session.flush()
        return address

    async def flush(self) -> None:
        await self._session.flush()

    async def delete(self, address: SavedAddress) -> None:
        await self._session.delete(address)
        await self._session.flush()
