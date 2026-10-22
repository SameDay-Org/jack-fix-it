"""Users: the only way other modules read or create accounts. The caller owns the commit.

Returns UserAccount / UserCredentials values (types.py), never the ORM model (ADR 0003).
"""

import uuid
from collections.abc import Collection
from datetime import datetime

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import violated_constraint
from app.modules.users.errors import (
    EmailAlreadyRegisteredError,
    NamesIncompleteError,
    PhoneUnavailableError,
)
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

    async def active_ids_with_role(
        self, user_ids: Collection[uuid.UUID], role: UserRole
    ) -> set[uuid.UUID]:
        """The ids among `user_ids` of active (not suspended) accounts with `role`."""
        return await self._users.active_ids_with_role(user_ids, role)

    async def get_by_id(self, user_id: uuid.UUID) -> UserAccount | None:
        user = await self._users.get_by_id(user_id)
        return _to_account(user) if user else None

    async def get_credentials_by_email(
        self, email: str, *, lock: bool = False
    ) -> UserCredentials | None:
        """For login and password reset. Exact match: emails are stored lowercase, so pass a
        normalized email. `lock` holds the user row until the transaction ends and reads it as
        last committed, so a login (after its password matched) and a password reset of the
        same user run one after the other."""
        user = await self._users.get_by_email(email, lock=lock)
        if user is None:
            return None
        return UserCredentials(account=_to_account(user), password_hash=user.password_hash)

    async def create_user(
        self,
        *,
        email: str,
        password_hash: str,
        role: UserRole,
        locale: str,
        first_name: str | None = None,
        last_name: str | None = None,
    ) -> UserAccount:
        """Inserts an active user. A taken email, even from a concurrent request, is a 409.

        The names are validated PersonName values, both or neither (callers check)."""
        user = User(
            email=email,
            password_hash=password_hash,
            role=role,
            locale=locale,
            status=UserStatus.ACTIVE,
            first_name=first_name,
            last_name=last_name,
        )
        savepoint = await self._session.begin_nested()
        try:
            await self._users.add(user)
        except IntegrityError as exc:
            await savepoint.rollback()
            if violated_constraint(exc) == _EMAIL_UNIQUE_CONSTRAINT:
                raise EmailAlreadyRegisteredError from None
            raise
        await savepoint.commit()
        return _to_account(user)

    async def set_role(self, user_id: uuid.UUID, role: UserRole, *, expected: UserRole) -> bool:
        """For the staff CLI only (scripts/create_staff_user.py); the caller owns the commit.

        Compare-and-set in one UPDATE: the role changes only if it is still `expected`, the
        role the caller validated. False when another change landed first; nothing is written.
        """
        return await self._users.update_role(user_id, role, expected=expected)

    async def update_names(
        self, user_id: uuid.UUID, *, first_name: str | None, last_name: str | None
    ) -> UserAccount:
        """Sets the given names (None keeps the stored one); the caller owns the commit.

        Locks the row, so the check below sees what is committed: a name may change alone only
        when the other is already stored. NamesIncompleteError (422) otherwise.
        """
        user = await self._users.get_by_id_for_update(user_id)
        if user is None:
            raise LookupError("user not found")
        first = first_name if first_name is not None else user.first_name
        last = last_name if last_name is not None else user.last_name
        if first is None or last is None:
            raise NamesIncompleteError
        user.first_name, user.last_name = first, last
        await self._session.flush()
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
            if violated_constraint(exc) == _PHONE_UNIQUE_CONSTRAINT:
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
        first_name=user.first_name,
        last_name=user.last_name,
    )
