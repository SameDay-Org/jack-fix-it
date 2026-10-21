"""Users: the only way other modules read or create accounts. The caller owns the commit.

Returns UserAccount / UserCredentials values (types.py), never the ORM model (ADR 0003).
"""

import uuid
from datetime import datetime

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.errors import EmailAlreadyRegisteredError, PhoneUnavailableError
from app.modules.users.models import User
from app.modules.users.repository import UserRepository
from app.modules.users.types import UserAccount, UserCredentials, UserRole, UserStatus

# Named by app.db.NAMING_CONVENTION.
_EMAIL_UNIQUE_CONSTRAINT = "uq_users_email"
_PHONE_UNIQUE_CONSTRAINT = "uq_users_phone"


class UserService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._users = UserRepository(session)

    async def get_by_id(self, user_id: uuid.UUID) -> UserAccount | None:
        user = await self._users.get_by_id(user_id)
        return _to_account(user) if user else None

    async def get_credentials_by_email(
        self, email: str, *, lock: bool = False
    ) -> UserCredentials | None:
        """For login and password reset. Exact match: emails are stored lowercase, so pass a
        normalized email. `lock` holds the user row until the transaction ends, so a login and
        a password reset of the same user run one after the other."""
        user = await self._users.get_by_email(email, lock=lock)
        if user is None:
            return None
        return UserCredentials(account=_to_account(user), password_hash=user.password_hash)

    async def create_user(
        self, *, email: str, password_hash: str, role: UserRole, locale: str
    ) -> UserAccount:
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
        return _to_account(user)

    async def update_password_hash(self, user_id: uuid.UUID, password_hash: str) -> None:
        await self._users.update_password_hash(user_id, password_hash)

    async def phone_verified_by_other(self, phone: str, user_id: uuid.UUID) -> bool:
        """True when another account has verified this number."""
        return await self._users.phone_verified_by_other(phone, user_id)

    async def set_verified_phone(
        self, user_id: uuid.UUID, phone: str, verified_at: datetime
    ) -> UserAccount:
        """Stores the user's verified phone. Idempotent for the number already verified.

        A number taken by another account, even by a concurrent request, is a 409.
        """
        user = await self._users.get_by_id(user_id)
        if user is None:
            raise LookupError("user not found")
        if user.phone == phone and user.phone_verified_at is not None:
            return _to_account(user)
        savepoint = await self._session.begin_nested()
        try:
            await self._users.set_verified_phone(user_id, phone, verified_at)
        except IntegrityError as exc:
            await savepoint.rollback()
            if _violated_constraint(exc) == _PHONE_UNIQUE_CONSTRAINT:
                raise PhoneUnavailableError from None
            raise
        await savepoint.commit()
        await self._session.refresh(user)
        return _to_account(user)


def _to_account(user: User) -> UserAccount:
    return UserAccount(
        id=user.id,
        email=user.email,
        role=user.role,
        locale=user.locale,
        status=user.status,
        phone=user.phone,
        phone_verified_at=user.phone_verified_at,
    )


def _violated_constraint(exc: IntegrityError) -> str | None:
    # asyncpg's exception, wrapped by SQLAlchemy's DBAPI adapter, carries the constraint name.
    name = getattr(exc.orig.__cause__, "constraint_name", None) if exc.orig else None
    return name if isinstance(name, str) else None
