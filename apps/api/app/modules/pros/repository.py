import uuid
from collections.abc import Collection, Sequence

from sqlalchemy import Select, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.pros.models import (
    ProCategory,
    ProDocument,
    ProDocumentStatus,
    ProDocumentType,
    ProProfile,
    ProServiceArea,
    ProVerificationStatus,
)


class ProProfileRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def dispatch_candidates(
        self, category_id: uuid.UUID, service_area_ids: Collection[uuid.UUID]
    ) -> list[ProProfile]:
        if not service_area_ids:
            return []
        in_category = select(ProCategory.pro_id).where(ProCategory.category_id == category_id)
        in_areas = select(ProServiceArea.pro_id).where(
            ProServiceArea.service_area_id.in_(service_area_ids)
        )
        statement = select(ProProfile).where(
            ProProfile.verification_status == ProVerificationStatus.APPROVED,
            ProProfile.payouts_enabled,
            ProProfile.id.in_(in_category),
            ProProfile.id.in_(in_areas),
        )
        return list((await self._session.scalars(statement)).all())

    @staticmethod
    def photo_keys_among(keys: Collection[str]) -> Select[str | None]:
        """The photo keys among `keys` that profiles hold, for another module's query."""
        return select(ProProfile.photo_key).where(ProProfile.photo_key.in_(keys))

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


class ProDocumentRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    @staticmethod
    def file_keys_among(keys: Collection[str]) -> Select[str]:
        """The file keys among `keys` that documents hold (superseded ones too), for another
        module's query."""
        return select(ProDocument.file_key).where(ProDocument.file_key.in_(keys))

    async def supersede_pending(self, pro_id: uuid.UUID, doc_type: ProDocumentType) -> int:
        """Marks the pending documents of this type superseded; returns how many."""
        result = await self._session.execute(
            update(ProDocument)
            .where(
                ProDocument.pro_id == pro_id,
                ProDocument.doc_type == doc_type,
                ProDocument.status == ProDocumentStatus.PENDING,
            )
            .values(status=ProDocumentStatus.SUPERSEDED, updated_at=func.now())
        )
        return int(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of an UPDATE

    async def add(self, document: ProDocument) -> ProDocument:
        """Inserts now (flush), so a reused file key surfaces here as a unique violation."""
        self._session.add(document)
        await self._session.flush()
        await self._session.refresh(document)
        return document

    async def current_of(self, pro_id: uuid.UUID) -> list[ProDocument]:
        """The pro's documents except superseded ones, newest first."""
        statement = (
            select(ProDocument)
            .where(
                ProDocument.pro_id == pro_id,
                ProDocument.status != ProDocumentStatus.SUPERSEDED,
            )
            .order_by(ProDocument.created_at.desc(), ProDocument.id.desc())
        )
        return list((await self._session.scalars(statement)).all())
