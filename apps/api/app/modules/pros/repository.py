import uuid
from collections.abc import Sequence

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.pros.models import ProCategory, ProProfile, ProServiceArea


class ProProfileRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_id_by_user_id(self, user_id: uuid.UUID) -> uuid.UUID | None:
        return await self._session.scalar(
            select(ProProfile.id).where(ProProfile.user_id == user_id)
        )

    async def insert_if_missing(self, user_id: uuid.UUID) -> bool:
        """Creates the user's empty profile (pending); True when this call created it.

        ON CONFLICT (user_id) DO NOTHING: of two concurrent first calls, one inserts and the
        other finds the row, with no unique violation.
        """
        statement = (
            insert(ProProfile)
            .values(user_id=user_id)
            .on_conflict_do_nothing(index_elements=[ProProfile.user_id])
            .returning(ProProfile.id)
        )
        return (await self._session.scalar(statement)) is not None

    async def get_by_user_id(self, user_id: uuid.UUID, *, lock: bool = False) -> ProProfile | None:
        """`lock`: FOR UPDATE until the transaction ends, so two edits of one profile run one
        after the other (their set replacements would otherwise collide)."""
        statement = select(ProProfile).where(ProProfile.user_id == user_id)
        if lock:
            statement = statement.with_for_update().execution_options(populate_existing=True)
        return await self._session.scalar(statement)

    async def category_ids(self, pro_id: uuid.UUID) -> list[uuid.UUID]:
        statement = select(ProCategory.category_id).where(ProCategory.pro_id == pro_id)
        return list((await self._session.scalars(statement)).all())

    async def service_area_ids(self, pro_id: uuid.UUID) -> list[uuid.UUID]:
        statement = select(ProServiceArea.service_area_id).where(ProServiceArea.pro_id == pro_id)
        return list((await self._session.scalars(statement)).all())

    async def replace_categories(self, pro_id: uuid.UUID, ids: Sequence[uuid.UUID]) -> None:
        await self._session.execute(delete(ProCategory).where(ProCategory.pro_id == pro_id))
        self._session.add_all(ProCategory(pro_id=pro_id, category_id=i) for i in ids)
        await self._session.flush()

    async def replace_service_areas(self, pro_id: uuid.UUID, ids: Sequence[uuid.UUID]) -> None:
        await self._session.execute(delete(ProServiceArea).where(ProServiceArea.pro_id == pro_id))
        self._session.add_all(ProServiceArea(pro_id=pro_id, service_area_id=i) for i in ids)
        await self._session.flush()
