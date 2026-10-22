import uuid
from collections.abc import Collection, Sequence

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.service_areas.models import ServiceArea
from app.modules.service_areas.schemas import ServiceAreaSeed


class ServiceAreaRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def insert_missing(self, entries: Sequence[ServiceAreaSeed]) -> list[str]:
        """Inserts the entries whose ZIP does not exist yet; returns the inserted ZIPs.

        One INSERT ... ON CONFLICT (zip_code) DO NOTHING: an existing row is never touched.
        """
        if not entries:
            return []
        statement = (
            insert(ServiceArea)
            .values([entry.model_dump(exclude={"county"}) for entry in entries])
            .on_conflict_do_nothing(index_elements=[ServiceArea.zip_code])
            .returning(ServiceArea.zip_code)
        )
        return list((await self._session.scalars(statement)).all())

    async def list_active(self) -> list[ServiceArea]:
        statement = (
            select(ServiceArea)
            .where(ServiceArea.active)
            .order_by(ServiceArea.region, ServiceArea.city, ServiceArea.zip_code)
        )
        return list((await self._session.scalars(statement)).all())

    async def active_ids(self, ids: Collection[uuid.UUID]) -> set[uuid.UUID]:
        if not ids:
            return set()
        statement = select(ServiceArea.id).where(ServiceArea.id.in_(ids), ServiceArea.active)
        return set((await self._session.scalars(statement)).all())

    async def active_ids_for_zip(self, zip_code: str) -> set[uuid.UUID]:
        statement = select(ServiceArea.id).where(
            ServiceArea.zip_code == zip_code, ServiceArea.active
        )
        return set((await self._session.scalars(statement)).all())

    async def get_many(self, ids: Collection[uuid.UUID]) -> list[ServiceArea]:
        if not ids:
            return []
        statement = (
            select(ServiceArea).where(ServiceArea.id.in_(ids)).order_by(ServiceArea.zip_code)
        )
        return list((await self._session.scalars(statement)).all())

    async def active_cities(self, zip_codes: Collection[str]) -> dict[str, str]:
        """The city of each active area among `zip_codes` (5 digits each)."""
        if not zip_codes:
            return {}
        statement = select(ServiceArea.zip_code, ServiceArea.city).where(
            ServiceArea.zip_code.in_(zip_codes), ServiceArea.active
        )
        return {zip_code: city for zip_code, city in (await self._session.execute(statement)).all()}

    async def is_active_zip(self, zip_code: str) -> bool:
        statement = select(ServiceArea.id).where(
            ServiceArea.zip_code == zip_code, ServiceArea.active
        )
        return (await self._session.scalar(statement)) is not None
