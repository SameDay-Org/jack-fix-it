import uuid
from collections.abc import Collection, Sequence
from datetime import datetime
from decimal import Decimal

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

# Only an approved profile with payouts enabled receives requests (context doc section 5).
_RECEIVES_REQUESTS = (
    ProProfile.verification_status == ProVerificationStatus.APPROVED,
    ProProfile.payouts_enabled,
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
            *_RECEIVES_REQUESTS,
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

    async def public_fields(
        self, pro_ids: Collection[uuid.UUID], *, hireable_only: bool
    ) -> list[tuple[uuid.UUID, uuid.UUID, Decimal | None, int, int | None, ProVerificationStatus]]:
        """(id, user_id, rating_avg, jobs_count, years_of_experience, verification_status) only:
        never the bio, the photo key or the Stripe account. With `hireable_only`, only the pros
        who still receive requests (approved, payouts enabled): the others cannot be hired or
        paid out (#189)."""
        if not pro_ids:
            return []
        hireable = _RECEIVES_REQUESTS if hireable_only else ()
        statement = select(
            ProProfile.id,
            ProProfile.user_id,
            ProProfile.rating_avg,
            ProProfile.jobs_count,
            ProProfile.years_of_experience,
            ProProfile.verification_status,
        ).where(ProProfile.id.in_(pro_ids), *hireable)
        return [
            (row[0], row[1], row[2], row[3], row[4], row[5])
            for row in (await self._session.execute(statement)).all()
        ]

    async def public_details(
        self, pro_id: uuid.UUID
    ) -> tuple[str | None, datetime, list[uuid.UUID]] | None:
        """(bio, created_at, category ids) of one profile, in one query, for the profile a
        customer sees (#53): never the photo key, the documents, the service areas or the
        Stripe account. None when there is no such profile."""
        statement = (
            select(
                ProProfile.bio,
                ProProfile.created_at,
                func.array_agg(ProCategory.category_id).filter(
                    ProCategory.category_id.is_not(None)
                ),
            )
            .outerjoin(ProCategory, ProCategory.pro_id == ProProfile.id)
            .where(ProProfile.id == pro_id)
            .group_by(ProProfile.id)
        )
        row = (await self._session.execute(statement)).one_or_none()
        if row is None:
            return None
        bio, created_at, category_ids = row
        # array_agg over no row is NULL.
        return bio, created_at, list(category_ids or [])

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

    async def set_stripe_account_id(self, pro_id: uuid.UUID, account_id: str) -> None:
        await self._session.execute(
            update(ProProfile)
            .where(ProProfile.id == pro_id)
            .values(stripe_account_id=account_id, updated_at=func.now())
        )

    async def set_stripe_account_requested_now(self, pro_id: uuid.UUID) -> None:
        await self._session.execute(
            update(ProProfile)
            .where(ProProfile.id == pro_id)
            .values(stripe_account_requested_at=func.now(), updated_at=func.now())
        )

    async def set_payouts_enabled(self, pro_id: uuid.UUID, enabled: bool) -> bool:
        """True when the stored value changed; a profile that already matches is not written."""
        result = await self._session.execute(
            update(ProProfile)
            .where(ProProfile.id == pro_id, ProProfile.payouts_enabled.is_distinct_from(enabled))
            .values(payouts_enabled=enabled, updated_at=func.now())
        )
        return bool(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of an UPDATE

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
