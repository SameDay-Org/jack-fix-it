"""Addresses: the only way other modules store or read an address (ADR 0003).

AddressService keeps a request's address snapshot. The caller owns the transaction: its
methods flush and never commit. SavedAddressService is the customer's address book (#214): a
resource of its own, with a router, a limit and a lock, so it owns its transactions and
commits. The two never share a row: a saved address is copied into a request by the app.
"""

import logging
import uuid
from collections.abc import Collection
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.addresses.errors import (
    AddressLabelTakenError,
    AddressLimitReachedError,
    AddressNotFoundError,
)
from app.modules.addresses.models import Address, SavedAddress
from app.modules.addresses.repository import AddressRepository, SavedAddressRepository
from app.modules.addresses.schemas import (
    COORDINATE_PLACES,
    AddressIn,
    AddressOut,
    SavedAddressIn,
    SavedAddressList,
    SavedAddressOut,
    SavedAddressPatch,
)
from app.modules.service_areas.service import ServiceAreaService
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)


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

    async def zip_codes(self, address_ids: Collection[uuid.UUID]) -> dict[uuid.UUID, str]:
        """The ZIP per address as stored (5 digits or ZIP+4), nothing else: pros see where a job
        is by ZIP and the canonical city of its service area (#49, #172)."""
        return dict(await self._addresses.zip_codes(address_ids))

    async def street_lines(
        self, address_ids: Collection[uuid.UUID]
    ) -> dict[uuid.UUID, tuple[str, ...]]:
        """The street line and, when set, the unit line per address. Only for masking the
        customer's own street in text shown to pros (#172); never returned to a pro."""
        return {
            address_id: (line1, line2) if line2 else (line1,)
            for address_id, line1, line2 in await self._addresses.street_lines(address_ids)
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


_QUANTUM = Decimal(1).scaleb(-COORDINATE_PLACES)


def _to_decimal(value: float | None) -> Decimal | None:
    """The coordinate as the column keeps it (six decimals, ties away from zero like Postgres),
    so the response shows exactly what was stored."""
    if value is None:
        return None
    return Decimal(str(value)).quantize(_QUANTUM, rounding=ROUND_HALF_UP)


def _to_out(row: SavedAddress, *, served: bool) -> SavedAddressOut:
    return SavedAddressOut(
        id=row.id,
        label=row.label,
        line1=row.line1,
        line2=row.line2,
        city=row.city,
        state=row.state,
        zip_code=row.zip_code,
        lat=None if row.lat is None else float(row.lat),
        lng=None if row.lng is None else float(row.lng),
        is_default=row.is_default,
        served=served,
    )


class SavedAddressService:
    """A customer's saved addresses: at most `max_per_user`, one of them the default.

    Every change first takes the user's lock (SavedAddressRepository.lock_user) and reads
    after it, so two concurrent creates count one after the other (never a fifth address) and
    two moves of the default never collide on the partial unique index. Logs carry ids and
    counts only: never a label, a street, a city, a ZIP or a coordinate.
    """

    def __init__(
        self, session: AsyncSession, service_areas: ServiceAreaService, max_per_user: int
    ) -> None:
        self._session = session
        self._saved = SavedAddressRepository(session)
        self._service_areas = service_areas
        self._max_per_user = max_per_user

    async def list_own(self, user: UserAccount) -> SavedAddressList:
        """The default first, then the oldest first, each flagged served or not. Two queries
        whatever the count: the rows, then which of their ZIPs have an active area."""
        rows = await self._saved.list_for_user(user.id)
        served = await self._service_areas.served_zips([row.zip_code for row in rows])
        return SavedAddressList(items=[_to_out(row, served=row.zip_code in served) for row in rows])

    async def create(self, user: UserAccount, data: SavedAddressIn) -> SavedAddressOut:
        """Adds an address and commits. The first one is the default; `is_default` moves the
        default to the new one. An unserved ZIP is saved too (the app offers the waitlist)."""
        await self._saved.lock_user(user.id)
        count = await self._saved.count_for_user(user.id)
        if count >= self._max_per_user:
            raise AddressLimitReachedError
        if await self._saved.label_taken(user.id, data.label):
            raise AddressLabelTakenError
        is_default = data.is_default or count == 0
        if is_default:
            await self._saved.clear_default(user.id)
        row = await self._saved.add(
            SavedAddress(
                user_id=user.id,
                label=data.label,
                line1=data.line1,
                line2=data.line2 or None,
                city=data.city,
                state=data.state,
                zip_code=data.zip_code,
                lat=_to_decimal(data.lat),
                lng=_to_decimal(data.lng),
                is_default=is_default,
            )
        )
        served = await self._service_areas.is_served(row.zip_code)
        await self._session.commit()
        logger.info(
            "saved_address_created",
            extra={
                "user_id": str(user.id),
                "address_id": str(row.id),
                "count": count + 1,
                "is_default": is_default,
            },
        )
        return _to_out(row, served=served)

    async def update(
        self, user: UserAccount, address_id: uuid.UUID, data: SavedAddressPatch
    ) -> SavedAddressOut:
        """Changes the fields sent and commits. `is_default` true moves the default here."""
        await self._saved.lock_user(user.id)
        row = await self._saved.get_own(user.id, address_id)
        if row is None:
            raise AddressNotFoundError
        sent = data.model_fields_set
        if data.label is not None and await self._saved.label_taken(
            user.id, data.label, except_id=row.id
        ):
            raise AddressLabelTakenError
        made_default = data.is_default is True and not row.is_default
        if made_default:
            # The old default is cleared before this row is flushed as the new one.
            await self._saved.clear_default(user.id)
            row.is_default = True
        if data.label is not None:
            row.label = data.label
        if data.line1 is not None:
            row.line1 = data.line1
        if "line2" in sent:
            row.line2 = data.line2 or None
        if data.city is not None:
            row.city = data.city
        if data.state is not None:
            row.state = data.state
        if data.zip_code is not None:
            row.zip_code = data.zip_code
        if "lat" in sent:  # with lng: the schema takes them together
            row.lat = _to_decimal(data.lat)
            row.lng = _to_decimal(data.lng)
        await self._saved.flush()
        served = await self._service_areas.is_served(row.zip_code)
        await self._session.commit()
        logger.info(
            "saved_address_updated",
            extra={
                "user_id": str(user.id),
                "address_id": str(row.id),
                "changed": len(sent),
                "made_default": made_default,
            },
        )
        return _to_out(row, served=served)

    async def delete(self, user: UserAccount, address_id: uuid.UUID) -> None:
        """Removes the address and commits. Deleting the default promotes the oldest remaining
        one; deleting the last leaves none."""
        await self._saved.lock_user(user.id)
        row = await self._saved.get_own(user.id, address_id)
        if row is None:
            raise AddressNotFoundError
        was_default = row.is_default
        await self._saved.delete(row)
        promoted: uuid.UUID | None = None
        if was_default:
            oldest = await self._saved.oldest_for_user(user.id)
            if oldest is not None:
                oldest.is_default = True
                await self._saved.flush()
                promoted = oldest.id
        await self._session.commit()
        logger.info(
            "saved_address_deleted",
            extra={
                "user_id": str(user.id),
                "address_id": str(address_id),
                "promoted_id": None if promoted is None else str(promoted),
            },
        )
