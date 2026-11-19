import uuid
from collections.abc import Collection
from datetime import datetime

from sqlalchemy import Select, Subquery, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.disputes.models import (
    RELEASES,
    Dispute,
    DisputePhoto,
    DisputeResolution,
    DisputeStatus,
)
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

    async def get(self, dispute_id: uuid.UUID, *, lock: bool = False) -> Dispute | None:
        """The dispute as last committed; with `lock`, its row held FOR UPDATE until the
        transaction ends (take the job's lock first)."""
        statement = (
            select(Dispute)
            .where(Dispute.id == dispute_id)
            .execution_options(populate_existing=True)
        )
        if lock:
            statement = statement.with_for_update()
        return (await self._session.scalars(statement)).one_or_none()

    async def resolve(
        self,
        dispute_id: uuid.UUID,
        *,
        resolution: DisputeResolution,
        note: str,
        by: uuid.UUID,
        now: datetime,
        pro_release_cents: int,
        customer_refund_cents: int,
    ) -> bool:
        """Resolves the dispute if it is still open; False otherwise (nothing written). One
        statement, so the status and the columns its CHECK ties to it change together."""
        statement = (
            update(Dispute)
            .where(Dispute.id == dispute_id, Dispute.status == DisputeStatus.OPEN)
            .values(
                status=DisputeStatus.RESOLVED,
                resolution=resolution,
                resolution_note=note,
                resolved_by=by,
                resolved_at=now,
                pro_release_cents=pro_release_cents,
                customer_refund_cents=customer_refund_cents,
            )
            .returning(Dispute.id)
        )
        return (await self._session.scalar(statement)) is not None

    async def released_of_job(self, job_id: uuid.UUID) -> Dispute | None:
        """The job's dispute when an admin resolved it with a release, full or partial (#76)."""
        statement = (
            select(Dispute)
            .where(
                Dispute.job_id == job_id,
                Dispute.status == DisputeStatus.RESOLVED,
                Dispute.resolution.in_(RELEASES),
            )
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def listed(self, status: DisputeStatus | None, limit: int) -> list[Dispute]:
        """Up to `limit` disputes (of `status`, or any), oldest first: the longest waiting
        first."""
        statement = select(Dispute).order_by(Dispute.created_at, Dispute.id).limit(limit)
        if status is not None:
            statement = statement.where(Dispute.status == status)
        return list((await self._session.scalars(statement)).all())

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
        """Every dispute's opening time (`created_at`) and job (`job_id`), and once an admin
        resolved it, when (`resolved_at`), whether it released the payout in full
        (`released_in_full`) or refunded the customer in full (`refunded_in_full`), and the
        split #76 stored (`pro_release_cents`, `customer_refund_cents`), for the staff metrics
        (#84). No text."""
        return select(
            Dispute.created_at.label("created_at"),
            Dispute.job_id.label("job_id"),
            Dispute.resolved_at.label("resolved_at"),
            (Dispute.resolution == DisputeResolution.RELEASED).label("released_in_full"),
            (Dispute.resolution == DisputeResolution.REFUNDED).label("refunded_in_full"),
            Dispute.pro_release_cents.label("pro_release_cents"),
            Dispute.customer_refund_cents.label("customer_refund_cents"),
        ).subquery()

    @staticmethod
    def open_jobs() -> Subquery:
        """The job (`job_id`) of every open dispute, for another module's query."""
        return (
            select(Dispute.job_id.label("job_id"))
            .where(Dispute.status == DisputeStatus.OPEN)
            .subquery()
        )

    @staticmethod
    def released_jobs() -> Subquery:
        """The job (`job_id`) of every dispute an admin resolved with a release, full or
        partial (#76), and the part of the pro's payout released (`pro_release_cents`), for
        another module's query."""
        return (
            select(
                Dispute.job_id.label("job_id"),
                Dispute.pro_release_cents.label("pro_release_cents"),
            )
            .where(Dispute.status == DisputeStatus.RESOLVED, Dispute.resolution.in_(RELEASES))
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
