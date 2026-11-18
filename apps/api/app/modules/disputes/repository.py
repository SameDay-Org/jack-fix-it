import uuid
from collections.abc import Collection
from datetime import datetime

from sqlalchemy import Select, Subquery, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.disputes.models import Dispute, DisputePhoto, DisputeStatus
from app.modules.media.safe_status import MediaSafeStatus


class DisputeRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def of_job(self, job_id: uuid.UUID) -> Dispute | None:
        """The job's dispute as last committed (a row read earlier in the session is
        refreshed)."""
        statement = (
            select(Dispute)
            .where(Dispute.job_id == job_id)
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def by_idempotency_key(self, opened_by: uuid.UUID, key: uuid.UUID) -> Dispute | None:
        """The customer's dispute made with `key` (the unique index allows one), as last
        committed."""
        statement = (
            select(Dispute)
            .where(Dispute.opened_by == opened_by, Dispute.idempotency_key == key)
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def add(self, dispute: Dispute) -> Dispute:
        """Inserts now (flush): a dispute of the same job committed meanwhile fails here, on
        its unique job_id."""
        self._session.add(dispute)
        await self._session.flush()
        return dispute

    async def is_open_for(self, job_id: uuid.UUID) -> bool:
        statement = select(Dispute.id).where(
            Dispute.job_id == job_id, Dispute.status == DisputeStatus.OPEN
        )
        return (await self._session.scalar(statement)) is not None

    @staticmethod
    def metric_facts() -> Subquery:
        """Every dispute's opening time (`created_at`), for the staff metrics (#84)."""
        return select(Dispute.created_at.label("created_at")).subquery()

    @staticmethod
    def open_jobs() -> Subquery:
        """The job (`job_id`) of every open dispute, for another module's query."""
        return (
            select(Dispute.job_id.label("job_id"))
            .where(Dispute.status == DisputeStatus.OPEN)
            .subquery()
        )

    async def set_pro_reply(self, dispute_id: uuid.UUID, reply: str, now: datetime) -> bool:
        """Stores the pro's reply if the dispute is open and has none; False otherwise. The
        condition is the once rule: of two replies at once, the second finds the first."""
        statement = (
            update(Dispute)
            .where(
                Dispute.id == dispute_id,
                Dispute.status == DisputeStatus.OPEN,
                Dispute.pro_reply.is_(None),
            )
            .values(pro_reply=reply, pro_replied_at=now)
            .returning(Dispute.id)
        )
        return (await self._session.scalar(statement)) is not None


class DisputePhotoRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def of_dispute(self, dispute_id: uuid.UUID) -> list[DisputePhoto]:
        """The dispute's photos, in the order the customer gave them, as last committed."""
        statement = (
            select(DisputePhoto)
            .where(DisputePhoto.dispute_id == dispute_id)
            .order_by(DisputePhoto.created_at, DisputePhoto.id)
            .execution_options(populate_existing=True)
        )
        return list((await self._session.scalars(statement)).all())

    async def held_keys(self, keys: Collection[str]) -> set[str]:
        """The keys among `keys` that any dispute photo already holds."""
        return set((await self._session.scalars(self.keys_among(keys))).all())

    async def add_all(self, photos: Collection[DisputePhoto]) -> None:
        self._session.add_all(photos)
        await self._session.flush()

    async def pending(
        self, dispute_id: uuid.UUID, photo_ids: Collection[uuid.UUID]
    ) -> list[DisputePhoto]:
        """Those of the dispute's photos `photo_ids` still without a safe copy, oldest first."""
        statement = (
            select(DisputePhoto)
            .where(
                DisputePhoto.dispute_id == dispute_id,
                DisputePhoto.id.in_(photo_ids),
                DisputePhoto.safe_status == MediaSafeStatus.PENDING,
            )
            .order_by(DisputePhoto.created_at, DisputePhoto.id)
        )
        return list((await self._session.scalars(statement)).all())

    async def get_for_update(self, photo_id: uuid.UUID) -> DisputePhoto | None:
        """One photo, locked until the transaction ends, as the last writer left it."""
        statement = (
            select(DisputePhoto)
            .where(DisputePhoto.id == photo_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def fail_pending(self, photo_ids: Collection[uuid.UUID]) -> list[uuid.UUID]:
        """Marks those of the photos still pending failed; the ids it changed."""
        statement = (
            update(DisputePhoto)
            .where(
                DisputePhoto.id.in_(photo_ids),
                DisputePhoto.safe_status == MediaSafeStatus.PENDING,
            )
            .values(safe_status=MediaSafeStatus.FAILED)
            .returning(DisputePhoto.id)
            .execution_options(synchronize_session=False)
        )
        return list((await self._session.scalars(statement)).all())

    @staticmethod
    def keys_among(keys: Collection[str]) -> Select[str]:
        """The file keys among `keys` that dispute photos hold, for another module's query."""
        return select(DisputePhoto.file_key).where(DisputePhoto.file_key.in_(keys))
