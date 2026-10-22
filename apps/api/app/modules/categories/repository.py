import uuid
from collections.abc import Collection, Sequence

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.categories.models import Category
from app.modules.categories.schemas import CategorySeed


class CategoryRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def insert_missing(self, entries: Sequence[CategorySeed]) -> list[str]:
        """Inserts the entries whose slug does not exist yet; returns the inserted slugs.

        One INSERT … ON CONFLICT (slug) DO NOTHING: an existing row is never touched, and a
        concurrent seed cannot fail on the unique slug.
        """
        if not entries:
            return []
        statement = (
            insert(Category)
            .values([entry.model_dump() for entry in entries])
            .on_conflict_do_nothing(index_elements=[Category.slug])
            .returning(Category.slug)
        )
        return list((await self._session.scalars(statement)).all())

    async def is_active(self, category_id: uuid.UUID) -> bool:
        statement = select(Category.id).where(Category.id == category_id, Category.active)
        return (await self._session.scalar(statement)) is not None

    async def list_active(self) -> list[Category]:
        statement = select(Category).where(Category.active).order_by(Category.slug)
        return list((await self._session.scalars(statement)).all())

    async def active_ids(self, ids: Collection[uuid.UUID]) -> set[uuid.UUID]:
        if not ids:
            return set()
        statement = select(Category.id).where(Category.id.in_(ids), Category.active)
        return set((await self._session.scalars(statement)).all())

    async def get_many(self, ids: Collection[uuid.UUID]) -> list[Category]:
        if not ids:
            return []
        statement = select(Category).where(Category.id.in_(ids)).order_by(Category.slug)
        return list((await self._session.scalars(statement)).all())

    async def any_requires_license(self, ids: Collection[uuid.UUID]) -> bool:
        if not ids:
            return False
        statement = select(Category.id).where(Category.id.in_(ids), Category.requires_license)
        return (await self._session.scalar(statement.limit(1))) is not None
