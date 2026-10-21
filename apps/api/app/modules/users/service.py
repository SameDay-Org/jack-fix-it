"""Users: the only way other modules read or create accounts. The caller owns the commit."""

import uuid

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.errors import EmailAlreadyRegisteredError
from app.modules.users.models import User, UserRole, UserStatus
from app.modules.users.repository import UserRepository

# Named by app.db.NAMING_CONVENTION.
_EMAIL_UNIQUE_CONSTRAINT = "uq_users_email"


class UserService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._users = UserRepository(session)

    async def get_by_id(self, user_id: uuid.UUID) -> User | None:
        return await self._users.get_by_id(user_id)

    async def get_by_email(self, email: str) -> User | None:
        """Exact match: emails are stored lowercase, so pass a normalized email."""
        return await self._users.get_by_email(email)

    async def create_user(
        self, *, email: str, password_hash: str, role: UserRole, locale: str
    ) -> User:
        """Inserts an active user. A taken email, even from a concurrent request, is a 409."""
        user = User(
            email=email,
            password_hash=password_hash,
            role=role,
            locale=locale,
            status=UserStatus.ACTIVE,
        )
        savepoint = await self._session.begin_nested()
        try:
            await self._users.add(user)
        except IntegrityError as exc:
            await savepoint.rollback()
            if _violated_constraint(exc) == _EMAIL_UNIQUE_CONSTRAINT:
                raise EmailAlreadyRegisteredError from None
            raise
        await savepoint.commit()
        return user

    async def update_password_hash(self, user: User, password_hash: str) -> None:
        user.password_hash = password_hash
        await self._session.flush()


def _violated_constraint(exc: IntegrityError) -> str | None:
    # asyncpg's exception, wrapped by SQLAlchemy's DBAPI adapter, carries the constraint name.
    name = getattr(exc.orig.__cause__, "constraint_name", None) if exc.orig else None
    return name if isinstance(name, str) else None
