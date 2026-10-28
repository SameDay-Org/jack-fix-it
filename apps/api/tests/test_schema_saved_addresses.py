"""Schema of saved_addresses (D8.2, #214, ADR 0007)."""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.addresses.models import SavedAddress
from app.modules.users.models import User
from app.modules.users.types import UserRole
from tests.test_schema_core import assert_rejected


async def customer(session: AsyncSession) -> uuid.UUID:
    user = User(
        email=f"customer-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=UserRole.CUSTOMER
    )
    session.add(user)
    await session.flush()
    return user.id


def saved(user_id: uuid.UUID, label: str = "Home", **kw: object) -> SavedAddress:
    return SavedAddress(
        user_id=user_id,
        label=label,
        line1="742 Evergreen Terrace",
        city="Orlando",
        state="FL",
        zip_code="32801",
        **kw,
    )


async def test_at_most_one_default_per_user(db_session: AsyncSession) -> None:
    ana, bruno = await customer(db_session), await customer(db_session)
    db_session.add_all([saved(ana, is_default=True), saved(bruno, is_default=True)])
    await db_session.flush()  # one default each

    await assert_rejected(db_session, saved(ana, "Work", is_default=True))
    db_session.add(saved(ana, "Work", is_default=False))  # any number of others
    await db_session.flush()


async def test_label_unique_per_user_ignoring_case(db_session: AsyncSession) -> None:
    ana, bruno = await customer(db_session), await customer(db_session)
    db_session.add_all([saved(ana, "Home"), saved(bruno, "home")])  # another user's is fine
    await db_session.flush()

    await assert_rejected(db_session, saved(ana, "HOME"))
    await assert_rejected(db_session, saved(ana, "Home"))
    db_session.add(saved(ana, "Home 2"))
    await db_session.flush()


async def test_defaults_and_optional_coordinates(db_session: AsyncSession) -> None:
    row = saved(await customer(db_session))
    db_session.add(row)
    await db_session.flush()
    await db_session.refresh(row)

    assert row.is_default is False
    assert row.lat is None
    assert row.lng is None
    assert row.created_at is not None


async def test_user_must_exist(db_session: AsyncSession) -> None:
    await assert_rejected(db_session, saved(uuid.uuid4()))
