"""Categories: the catalog of services. Its launch content is data (seed_data.json).

A category's intake questions are stored JSON an admin may edit, so every read parses them;
questions that do not parse are logged by category id (never the JSON) and treated as broken.
"""

import logging
import uuid
from collections.abc import Collection, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.categories.intake import INTAKE_QUESTIONS, IntakeQuestion
from app.modules.categories.models import Category
from app.modules.categories.repository import CategoryRepository
from app.modules.categories.schemas import (
    CategoryOut,
    CategorySeed,
    CategorySeedCatalog,
    CategorySummary,
)

SEED_DATA_PATH: Final = Path(__file__).with_name("seed_data.json")

logger = logging.getLogger(__name__)


class BrokenIntakeQuestionsError(Exception):
    """The category's stored questions do not parse: nothing can be checked against them."""


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

    async def intake_questions(self, category_id: uuid.UUID) -> list[IntakeQuestion] | None:
        """The questions of an active category; None when it is unknown or inactive. Raises
        BrokenIntakeQuestionsError when its stored questions do not parse."""
        row = await self._categories.get_active(category_id)
        if row is None:
            return None
        questions = _parse_questions(row)
        if questions is None:
            raise BrokenIntakeQuestionsError
        return questions

    async def list_active(self) -> list[CategoryOut]:
        """The categories offered now, by slug. One whose questions do not parse is still
        listed, asking nothing; requests for it are refused until an admin fixes them."""
        return [
            CategoryOut(
                id=row.id,
                slug=row.slug,
                names=row.names,
                icon=row.icon,
                requires_license=row.requires_license,
                intake_questions=_parse_questions(row) or [],
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


def _parse_questions(row: Category) -> list[IntakeQuestion] | None:
    try:
        return INTAKE_QUESTIONS.validate_python(row.intake_questions)
    except ValidationError:
        # The error text echoes the stored JSON: the category id only.
        logger.error("category_intake_invalid", extra={"category_id": str(row.id)})
        return None
