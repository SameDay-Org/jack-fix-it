import uuid
from collections.abc import Collection
from datetime import datetime

from sqlalchemy import Select, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from app.modules.users.types import UserRole, UserStatus


class UserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def active_ids_with_role(
        self, user_ids: Collection[uuid.UUID], role: UserRole, *, lock: bool = False
    ) -> set[uuid.UUID]:
        if not user_ids:
            return set()
        statement = select(User.id).where(
            User.id.in_(user_ids), User.role == role, User.status == UserStatus.ACTIVE
        )
        if lock:
            statement = statement.order_by(User.id).with_for_update(read=True)
        return set((await self._session.scalars(statement)).all())

    @staticmethod
    def guest_ids() -> Select[uuid.UUID]:
        """The guests' ids (#86), as a statement for another module's query."""
        return select(User.id).where(User.status == UserStatus.GUEST)

    async def is_guest(self, user_id: uuid.UUID) -> bool:
        statement = select(User.status).where(User.id == user_id)
        return await self._session.scalar(statement) is UserStatus.GUEST

    async def ids_with_role(
        self, user_ids: Collection[uuid.UUID], role: UserRole
    ) -> set[uuid.UUID]:
        if not user_ids:
            return set()
        statement = select(User.id).where(User.id.in_(user_ids), User.role == role)
        return set((await self._session.scalars(statement)).all())

    @staticmethod
    def photo_keys_among(keys: Collection[str]) -> Select[str | None]:
        """The upload keys among `keys` that a user holds as their ID photo, as a statement
        (the uploads sweep of unreferenced uploads, #191)."""
        return select(User.photo_key).where(User.photo_key.in_(keys))

    @staticmethod
    def active_ids_of_role(role: UserRole) -> Select[uuid.UUID]:
        """The ids of the active accounts with `role`, as a statement."""
        return select(User.id).where(User.role == role, User.status == UserStatus.ACTIVE)

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

    async def active_staff(
        self,
    ) -> list[tuple[uuid.UUID, str | None, UserRole, str, str | None]]:
        """(id, first_name, role, email, phone) of every active agent and admin, by first name
        then id (#82): the email and phone only to withhold a first name that shows one."""
        statement = (
            select(User.id, User.first_name, User.role, User.email, User.phone)
            .where(
                User.role.in_((UserRole.AGENT, UserRole.ADMIN)),
                User.status == UserStatus.ACTIVE,
            )
            .order_by(User.first_name.nulls_last(), User.id)
        )
        return [
            (row[0], row[1], row[2], row[3], row[4])
            for row in (await self._session.execute(statement)).all()
        ]

    async def anonymise(
        self, user_id: uuid.UUID, *, email: str, password_hash: str, public_code: str
    ) -> None:
        """Overwrites every personal field of the account in one UPDATE (#97): see
        UserService.anonymise."""
        await self._session.execute(
            update(User)
            .where(User.id == user_id)
            .values(
                email=email,
                password_hash=password_hash,
                public_code=public_code,
                phone=None,
                phone_verified_at=None,
                first_name=None,
                last_name=None,
                home_city=None,
                home_state=None,
                photo_key=None,
                status=UserStatus.DELETED,
                # The first deletion's time: the worker's second pass anonymises again.
                deleted_at=func.coalesce(User.deleted_at, func.now()),
            )
        )

    async def names(
        self, user_ids: Collection[uuid.UUID]
    ) -> list[tuple[uuid.UUID, str | None, str | None, str, str | None, UserStatus]]:
        """(id, first_name, last_name, email, phone, status) only: the contacts withhold a name
        that shows one (names.safe_public_name), and a deleted account shows no name (#97)."""
        if not user_ids:
            return []
        statement = select(
            User.id, User.first_name, User.last_name, User.email, User.phone, User.status
        ).where(User.id.in_(user_ids))
        return [
            (row[0], row[1], row[2], row[3], row[4], row[5])
            for row in (await self._session.execute(statement)).all()
        ]

    async def get_by_id_for_deletion(self, user_id: uuid.UUID) -> User | None:
        """FOR UPDATE, not FOR NO KEY UPDATE (#97): until the deletion commits, a row that
        references the user (a request, an address, a device, a payment) cannot be inserted
        either, and a profile or phone write waits. Read as last committed."""
        statement = (
            select(User)
            .where(User.id == user_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

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

    async def get_by_id_for_share(self, user_id: uuid.UUID) -> User | None:
        """FOR SHARE until the transaction ends, read as last committed (never the session's
        copy): a change to the row waits for this transaction."""
        statement = (
            select(User)
            .where(User.id == user_id)
            .with_for_update(read=True)
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def get_by_id_for_update(self, user_id: uuid.UUID) -> User | None:
        """FOR NO KEY UPDATE until the transaction ends, read as last committed."""
        statement = (
            select(User)
            .where(User.id == user_id)
            .with_for_update(key_share=True)
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def get_stripe_customer_id(self, user_id: uuid.UUID) -> str | None:
        statement = select(User.stripe_customer_id).where(User.id == user_id)
        return await self._session.scalar(statement)

    async def get_stripe_customer_id_for_update(self, user_id: uuid.UUID) -> str | None:
        """The same read, the user's row locked until the transaction ends."""
        statement = select(User.stripe_customer_id).where(User.id == user_id).with_for_update()
        return await self._session.scalar(statement)

    async def set_stripe_customer_id_if_missing(self, user_id: uuid.UUID, customer_id: str) -> bool:
        """Stores the customer id unless the row holds one already; False then."""
        result = await self._session.execute(
            update(User)
            .where(User.id == user_id, User.stripe_customer_id.is_(None))
            .values(stripe_customer_id=customer_id)
        )
        return bool(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of an UPDATE

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
