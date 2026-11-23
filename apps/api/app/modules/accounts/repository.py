import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import ColumnElement, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.accounts.models import AccountDeletion


def _pending() -> ColumnElement[bool]:
    """Something is still to do (the partial index's condition, models.PENDING_CONDITION)."""
    return or_(
        AccountDeletion.storage_deleted_at.is_(None),
        AccountDeletion.cards_detached_at.is_(None),
        AccountDeletion.erased_again_at.is_(None),
    )


class AccountDeletionRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(
        self,
        user_id: uuid.UUID,
        *,
        storage_keys: list[str],
        storage_settled_after: datetime,
        erase_settled_after: datetime,
        cards_detached_at: datetime | None,
    ) -> None:
        self._session.add(
            AccountDeletion(
                user_id=user_id,
                storage_keys=storage_keys,
                storage_settled_after=storage_settled_after,
                erase_settled_after=erase_settled_after,
                cards_detached_at=cards_detached_at,
            )
        )
        await self._session.flush()

    async def claim(self, user_id: uuid.UUID, retry_after: timedelta) -> AccountDeletion | None:
        """Takes the user's cleanup for one attempt: counts it and stamps it, if there is still
        something to do and no attempt took it within `retry_after` (a task and a sweep, or
        two sweeps, never run it at once). None otherwise. The caller commits at once, before
        any call to Stripe or the storage."""
        statement = (
            update(AccountDeletion)
            .where(
                AccountDeletion.user_id == user_id,
                _pending(),
                or_(
                    AccountDeletion.last_attempt_at.is_(None),
                    AccountDeletion.last_attempt_at < func.now() - retry_after,
                ),
            )
            .values(attempts=AccountDeletion.attempts + 1, last_attempt_at=func.now())
            .returning(AccountDeletion)
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def record_second_pass(
        self,
        user_id: uuid.UUID,
        *,
        keys: list[str],
        has_stripe_customer: bool,
        files_settled_after: datetime,
    ) -> AccountDeletion:
        """The worker's second erasure is done: the files it found join the keys, the files'
        pass is open again whatever it found (a file stored since the last pass under the
        account's prefix is named by no row), and not the last before `files_settled_after`
        (a copy it found running); a Stripe Customer it found has its cards detached again.
        The row as it is now."""
        row = (
            await self._session.scalars(
                select(AccountDeletion)
                .where(AccountDeletion.user_id == user_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).one()
        row.erased_again_at = datetime.now(UTC)
        row.storage_keys = sorted({*row.storage_keys, *keys})
        row.storage_deleted_at = None
        row.storage_settled_after = max(row.storage_settled_after, files_settled_after)
        if has_stripe_customer:
            row.cards_detached_at = None
        await self._session.flush()
        return row

    async def record(
        self,
        user_id: uuid.UUID,
        *,
        cards_detached: bool,
        storage_deleted: bool,
        error: str | None,
    ) -> None:
        """What the attempt finished; a part done stays done."""
        values: dict[str, object] = {"last_error": error}
        if cards_detached:
            values["cards_detached_at"] = func.coalesce(
                AccountDeletion.cards_detached_at, func.now()
            )
        if storage_deleted:
            values["storage_deleted_at"] = func.coalesce(
                AccountDeletion.storage_deleted_at, func.now()
            )
            # The files are gone: their keys (which name the user) are kept no longer.
            values["storage_keys"] = []
        await self._session.execute(
            update(AccountDeletion).where(AccountDeletion.user_id == user_id).values(**values)
        )

    async def due(self, retry_after: timedelta, limit: int) -> list[uuid.UUID]:
        """The deleted accounts whose cleanup is not done and no attempt took within
        `retry_after`, least recently tried first (never tried first)."""
        statement = (
            select(AccountDeletion.user_id)
            .where(
                _pending(),
                or_(
                    AccountDeletion.last_attempt_at.is_(None),
                    AccountDeletion.last_attempt_at < func.now() - retry_after,
                ),
            )
            .order_by(AccountDeletion.last_attempt_at.asc().nulls_first(), AccountDeletion.id)
            .limit(limit)
        )
        return list(await self._session.scalars(statement))
