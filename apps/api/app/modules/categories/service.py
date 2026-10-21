"""Categories: the catalog of services. Its launch content is data (seed_data.json)."""

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.categories.repository import CategoryRepository
from app.modules.categories.schemas import CategorySeed, CategorySeedCatalog

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
