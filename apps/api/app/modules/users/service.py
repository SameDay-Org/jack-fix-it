"""Users: the only way other modules read or create accounts. The caller owns the commit.

Returns UserAccount / UserCredentials values (types.py), never the ORM model (ADR 0003).
"""

import logging
import uuid
from collections.abc import Collection
from datetime import datetime

from sqlalchemy import Select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import violated_constraint
from app.modules.uploads.keys import owned_upload
from app.modules.uploads.schemas import UploadPurpose
from app.modules.users import public_codes
from app.modules.users.errors import (
    EmailAlreadyRegisteredError,
    HomeLocationIncompleteError,
    InvalidPhotoError,
    NamesIncompleteError,
    PhoneUnavailableError,
    PublicCodeExhaustedError,
)
from app.modules.users.models import User
from app.modules.users.names import safe_public_name
from app.modules.users.repository import UserRepository
from app.modules.users.types import (
    KEEP,
    ContactPoints,
    Keep,
    UserAccount,
    UserCredentials,
    UserRole,
    UserStatus,
)
from app.redaction import KnownValues

logger = logging.getLogger(__name__)

# Named by app.db.NAMING_CONVENTION.
_EMAIL_UNIQUE_CONSTRAINT = "uq_users_email"
_PHONE_UNIQUE_CONSTRAINT = "uq_users_phone"
_PUBLIC_CODE_UNIQUE_CONSTRAINT = "uq_users_public_code"


class UserService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._users = UserRepository(session)

    @staticmethod
    def photo_keys_among(keys: Collection[str]) -> Select[str | None]:
        """The upload keys among `keys` that a user holds as their ID photo (#250), as a
        statement (the uploads sweep of unreferenced uploads, #191)."""
        return UserRepository.photo_keys_among(keys)

    async def active_ids_with_role(
        self, user_ids: Collection[uuid.UUID], role: UserRole
    ) -> set[uuid.UUID]:
        """The ids among `user_ids` of active (not suspended) accounts with `role`."""
        return await self._users.active_ids_with_role(user_ids, role)

    async def ids_with_role(
        self, user_ids: Collection[uuid.UUID], role: UserRole
    ) -> set[uuid.UUID]:
        """The ids among `user_ids` of accounts with `role`, whatever their status."""
        return await self._users.ids_with_role(user_ids, role)

    async def contact_points(
        self, user_ids: Collection[uuid.UUID]
    ) -> dict[uuid.UUID, ContactPoints]:
        """Each user's email and phone, read in one query. Only for masking a party's own
        details in text shown to the other side: a customer's to pros (#172), a pro's to the
        customer (#188). Never logged or returned to anyone."""
        return {
            user_id: ContactPoints(email=email, phone=phone)
            for user_id, email, phone in await self._users.contact_points(user_ids)
        }

    async def public_names(self, user_ids: Collection[uuid.UUID]) -> dict[uuid.UUID, str | None]:
        """Each user's public name ("María P.", names.safe_public_name), read in one query;
        None when a name is missing or shows a contact detail, the user's own email and phone
        included. The full names and the contacts never leave this module."""
        return {
            user_id: safe_public_name(
                first, last, KnownValues(emails=(email,), phones=(phone,) if phone else ())
            )
            for user_id, first, last, email, phone in await self._users.names(user_ids)
        }

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

        The names are validated PersonName values, both or neither (callers check). The public
        code (#250) is drawn here, for every path that creates a user: a code another account
        holds (even one inserted concurrently) is drawn again, up to public_codes.MAX_TRIES;
        then PublicCodeExhaustedError, a generic 500 that names no code."""
        for attempt in range(1, public_codes.MAX_TRIES + 1):
            user = User(
                email=email,
                password_hash=password_hash,
                role=role,
                locale=locale,
                status=UserStatus.ACTIVE,
                first_name=first_name,
                last_name=last_name,
                public_code=public_codes.generate_public_code(),
            )
            savepoint = await self._session.begin_nested()
            try:
                await self._users.add(user)
            except IntegrityError as exc:
                await savepoint.rollback()
                constraint = violated_constraint(exc)
                if constraint == _EMAIL_UNIQUE_CONSTRAINT:
                    raise EmailAlreadyRegisteredError from None
                if constraint == _PUBLIC_CODE_UNIQUE_CONSTRAINT:
                    logger.warning("public_code_collision", extra={"attempt": attempt})
                    continue
                raise
            await savepoint.commit()
            return _to_account(user)
        raise PublicCodeExhaustedError

    async def set_role(self, user_id: uuid.UUID, role: UserRole, *, expected: UserRole) -> bool:
        """For the staff CLI only (scripts/create_staff_user.py); the caller owns the commit.

        Compare-and-set in one UPDATE: the role changes only if it is still `expected`, the
        role the caller validated. False when another change landed first; nothing is written.
        """
        return await self._users.update_role(user_id, role, expected=expected)

    async def update_profile(
        self,
        user_id: uuid.UUID,
        *,
        first_name: str | None = None,
        last_name: str | None = None,
        home_city: str | Keep | None = KEEP,
        home_state: str | Keep | None = KEEP,
        photo_key: str | Keep | None = KEEP,
    ) -> UserAccount:
        """Sets the caller's own names, home city and state and ID photo (#165, #250); the
        caller owns the commit. A name given as None keeps the stored one; a card field given
        as KEEP does, and None clears it.

        Every check runs before the row changes, so a refusal stores nothing:
        - `photo_key` must be a well-formed profile_photo upload key of this very user
          (uploads.service.owned_upload): anyone else's, another purpose or a malformed one
          is InvalidPhotoError (422), without saying which check failed.
        - The city and the state are set together or cleared together
          (HomeLocationIncompleteError, 422); the database CHECK backs it.
        - The row is locked, so the names check sees what is committed: a name may change
          alone only when the other is already stored (NamesIncompleteError, 422). A PATCH
          without names leaves them alone, stored or not.
        """
        if (
            not isinstance(photo_key, Keep)
            and photo_key is not None
            and owned_upload(photo_key, user_id, UploadPurpose.PROFILE_PHOTO) is None
        ):
            raise InvalidPhotoError
        if isinstance(home_city, Keep) != isinstance(home_state, Keep) or (home_city is None) != (
            home_state is None
        ):
            raise HomeLocationIncompleteError
        user = await self._users.get_by_id_for_update(user_id)
        if user is None:
            raise LookupError("user not found")
        if first_name is not None or last_name is not None:
            first = first_name if first_name is not None else user.first_name
            last = last_name if last_name is not None else user.last_name
            if first is None or last is None:
                raise NamesIncompleteError
            user.first_name, user.last_name = first, last
        if not isinstance(home_city, Keep) and not isinstance(home_state, Keep):
            user.home_city, user.home_state = home_city, home_state
        if not isinstance(photo_key, Keep):
            user.photo_key = photo_key
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
        public_code=user.public_code,
        created_at=user.created_at,
        phone=user.phone,
        phone_verified_at=user.phone_verified_at,
        first_name=user.first_name,
        last_name=user.last_name,
        home_city=user.home_city,
        home_state=user.home_state,
        photo_key=user.photo_key,
    )
