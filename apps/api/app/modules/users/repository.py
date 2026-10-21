import uuid
from datetime import datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User


class UserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_by_id(self, user_id: uuid.UUID) -> User | None:
        return await self._session.get(User, user_id)

    async def get_by_email(self, email: str) -> User | None:
        result = await self._session.scalars(select(User).where(User.email == email))
        return result.one_or_none()

    async def add(self, user: User) -> User:
        """Inserts the user now (flush), so a unique violation surfaces here."""
        self._session.add(user)
        await self._session.flush()
        return user

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
