"""Categories: the catalog of services. Its launch content is data (seed_data.json)."""

import uuid
from collections.abc import Collection, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.categories.repository import CategoryRepository
from app.modules.categories.schemas import (
    CategoryOut,
    CategorySeed,
    CategorySeedCatalog,
    CategorySummary,
)

SEED_DATA_PATH: Final = Path(__file__).with_name("seed_data.json")


@dataclass(frozen=True)
class SeedResult:
    inserted: int
    skipped: int


def load_seed_data(path: Path = SEED_DATA_PATH) -> list[CategorySeed]:
    """The validated catalog. Raises pydantic.ValidationError on any invalid entry."""
    return CategorySeedCatalog.model_validate_json(path.read_bytes()).root


class CategoryService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._categories = CategoryRepository(session)

    async def seed(self, entries: Sequence[CategorySeed]) -> SeedResult:
        """Inserts the missing slugs and commits. Never updates a row: admin edits win."""
        inserted = await self._categories.insert_missing(entries)
        await self._session.commit()
        return SeedResult(inserted=len(inserted), skipped=len(entries) - len(inserted))

    async def is_active(self, category_id: uuid.UUID) -> bool:
        """True when the category exists and is offered (active)."""
        return await self._categories.is_active(category_id)

    async def list_active(self) -> list[CategoryOut]:
        """The categories offered now, by slug."""
        return [
            CategoryOut(
                id=row.id,
                slug=row.slug,
                names=row.names,
                icon=row.icon,
                requires_license=row.requires_license,
            )
            for row in await self._categories.list_active()
        ]

    async def active_ids(self, ids: Collection[uuid.UUID]) -> set[uuid.UUID]:
        """The ids among `ids` that exist and are active."""
        return await self._categories.active_ids(ids)

    async def summaries(self, ids: Collection[uuid.UUID]) -> list[CategorySummary]:
        """The categories with these ids, active or not, by slug."""
        return [
            CategorySummary(id=row.id, slug=row.slug, names=row.names)
            for row in await self._categories.get_many(ids)
        ]
