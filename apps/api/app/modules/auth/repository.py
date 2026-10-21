import uuid
from datetime import datetime

from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth.models import RefreshToken


class RefreshTokenRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, token: RefreshToken) -> RefreshToken:
        self._session.add(token)
        await self._session.flush()
        return token

    async def get_by_hash_for_update(self, token_hash: str) -> RefreshToken | None:
        """The token row, locked with its family until the transaction ends.

        The family lock comes first and serializes every change to a family: a revocation
        running while another token of the family is rotated would otherwise miss the row that
        rotation inserts (READ COMMITTED). No deadlock as long as the lock protocol holds:
        a request locks one family only (or, in revoke_all_for_user, several in id order),
        and always the families before any of their rows.
        populate_existing: a waiter gets the row as the transaction that held the lock left it.
        """
        family_id = await self._session.scalar(
            select(RefreshToken.family_id).where(RefreshToken.token_hash == token_hash)
        )
        if family_id is None:
            return None
        await self._lock_family(family_id)
        statement = (
            select(RefreshToken)
            .where(RefreshToken.token_hash == token_hash)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def revoke_family(self, family_id: uuid.UUID, now: datetime) -> None:
        """Revokes every token of the family that is not revoked yet, in one UPDATE."""
        await self._session.execute(
            update(RefreshToken)
            .where(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )

    async def revoke_all_for_user(self, user_id: uuid.UUID, now: datetime) -> None:
        """Revokes every live session of the user (password reset, #27).

        Takes the lock of each live family first, in id order, so a rotation in flight either
        commits before the UPDATE (whose new row the UPDATE then sees) or waits and finds its
        token revoked. Sorted, and taken before any row lock, so it cannot deadlock with a
        request holding one family.
        """
        families = await self._session.scalars(
            select(RefreshToken.family_id)
            .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
            .distinct()
            .order_by(RefreshToken.family_id)
        )
        for family_id in families.all():
            await self._lock_family(family_id)
        await self._session.execute(
            update(RefreshToken)
            .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )

    async def _lock_family(self, family_id: uuid.UUID) -> None:
        """Transaction-scoped lock serializing every change to one family."""
        await self._session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:family_id, 0))"),
            {"family_id": str(family_id)},
        )
