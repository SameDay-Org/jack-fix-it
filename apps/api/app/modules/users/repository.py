import uuid
from collections.abc import Collection
from datetime import datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from app.modules.users.types import UserRole, UserStatus


class UserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def active_ids_with_role(
        self, user_ids: Collection[uuid.UUID], role: UserRole
    ) -> set[uuid.UUID]:
        if not user_ids:
            return set()
        statement = select(User.id).where(
            User.id.in_(user_ids), User.role == role, User.status == UserStatus.ACTIVE
        )
        return set((await self._session.scalars(statement)).all())

    async def get_by_id(self, user_id: uuid.UUID) -> User | None:
        return await self._session.get(User, user_id)

    async def contact_points(
        self, user_ids: Collection[uuid.UUID]
    ) -> list[tuple[uuid.UUID, str, str | None]]:
        """(id, email, phone) only."""
        if not user_ids:
            return []
        statement = select(User.id, User.email, User.phone).where(User.id.in_(user_ids))
        return [(row[0], row[1], row[2]) for row in (await self._session.execute(statement)).all()]

    async def names(
        self, user_ids: Collection[uuid.UUID]
    ) -> list[tuple[uuid.UUID, str | None, str | None]]:
        """(id, first_name, last_name) only."""
        if not user_ids:
            return []
        statement = select(User.id, User.first_name, User.last_name).where(User.id.in_(user_ids))
        return [(row[0], row[1], row[2]) for row in (await self._session.execute(statement)).all()]

    async def get_by_email(self, email: str, *, lock: bool = False) -> User | None:
        """`lock`: FOR NO KEY UPDATE until the transaction ends, reading the row as last
        committed (populate_existing, not the copy an earlier read left in the session). Not
        FOR UPDATE, so rows that reference the user (refresh tokens, requests) can still be
        inserted meanwhile."""
        statement = select(User).where(User.email == email)
        if lock:
            statement = statement.with_for_update(key_share=True).execution_options(
                populate_existing=True
            )
        result = await self._session.scalars(statement)
        return result.one_or_none()

    async def get_by_id_for_update(self, user_id: uuid.UUID) -> User | None:
        """FOR NO KEY UPDATE until the transaction ends, read as last committed."""
        statement = (
            select(User)
            .where(User.id == user_id)
            .with_for_update(key_share=True)
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def add(self, user: User) -> User:
        """Inserts the user now (flush), so a unique violation surfaces here."""
        self._session.add(user)
        await self._session.flush()
        return user

    async def update_role(self, user_id: uuid.UUID, role: UserRole, *, expected: UserRole) -> bool:
        """Sets the role only if it is still `expected`; False when it changed meanwhile."""
        result = await self._session.execute(
            update(User).where(User.id == user_id, User.role == expected).values(role=role)
        )
        return bool(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of an UPDATE

    async def update_password_hash(self, user_id: uuid.UUID, password_hash: str) -> None:
        await self._session.execute(
            update(User).where(User.id == user_id).values(password_hash=password_hash)
        )

    async def phone_verified_by_other(self, phone: str, user_id: uuid.UUID) -> bool:
        statement = select(User.id).where(
            User.phone == phone, User.phone_verified_at.is_not(None), User.id != user_id
        )
        return (await self._session.scalar(statement.limit(1))) is not None

    async def set_verified_phone(
        self, user_id: uuid.UUID, phone: str, verified_at: datetime
    ) -> None:
        await self._session.execute(
            update(User)
            .where(User.id == user_id)
            .values(phone=phone, phone_verified_at=verified_at)
        )
