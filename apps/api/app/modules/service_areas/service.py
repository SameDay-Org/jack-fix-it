"""Service areas: the only way other modules read where Jack Fix It works (ADR 0003)."""

import uuid
from collections.abc import Collection, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.service_areas.repository import ServiceAreaRepository
from app.modules.service_areas.schemas import (
    CityOut,
    RegionOut,
    ServedCheckOut,
    ServiceAreaOut,
    ServiceAreaSeed,
    ServiceAreaSeedFile,
    ZipOut,
    zip5,
)

SEED_DATA_PATH: Final = Path(__file__).with_name("seed_data.json")


@dataclass(frozen=True)
class SeedResult:
    inserted: int
    skipped: int


def load_seed_data(path: Path = SEED_DATA_PATH) -> list[ServiceAreaSeed]:
    """The validated areas. Raises pydantic.ValidationError on any invalid entry."""
    return ServiceAreaSeedFile.model_validate_json(path.read_bytes()).service_areas


class ServiceAreaService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._areas = ServiceAreaRepository(session)

    async def seed(self, entries: Sequence[ServiceAreaSeed]) -> SeedResult:
        """Inserts the missing ZIPs and commits. Never updates a row: admin edits win."""
        inserted = await self._areas.insert_missing(entries)
        await self._session.commit()
        return SeedResult(inserted=len(inserted), skipped=len(entries) - len(inserted))

    async def active_grouped(self) -> list[RegionOut]:
        """Active areas as region -> city -> ZIPs, each level in alphabetical order."""
        regions: dict[str, dict[tuple[str, str], list[ZipOut]]] = {}
        for area in await self._areas.list_active():
            cities = regions.setdefault(area.region, {})
            cities.setdefault((area.city, area.state), []).append(
                ZipOut(id=area.id, zip_code=area.zip_code)
            )
        return [
            RegionOut(
                region=region,
                cities=[
                    CityOut(city=city, state=state, zips=zips)
                    for (city, state), zips in cities.items()
                ],
            )
            for region, cities in regions.items()
        ]

    async def active_ids(self, ids: Collection[uuid.UUID]) -> set[uuid.UUID]:
        """The ids among `ids` that exist and are active."""
        return await self._areas.active_ids(ids)

    async def active_ids_for_zip(self, zip_code: str) -> set[uuid.UUID]:
        """The active areas serving a five-digit ZIP (none when it is not served)."""
        return await self._areas.active_ids_for_zip(zip_code)

    async def get_many(self, ids: Collection[uuid.UUID]) -> list[ServiceAreaOut]:
        """The areas with these ids, active or not, by ZIP."""
        return [
            ServiceAreaOut(
                id=area.id,
                zip_code=area.zip_code,
                city=area.city,
                state=area.state,
                region=area.region,
            )
            for area in await self._areas.get_many(ids)
        ]

    async def is_served(self, zip_code: str) -> bool:
        """True when the ZIP (5 digits or ZIP+4) is an active service area."""
        return await self._areas.is_active_zip(zip5(zip_code))

    async def check(self, zip_code: str) -> ServedCheckOut:
        return ServedCheckOut(zip_code=zip5(zip_code), served=await self.is_served(zip_code))
