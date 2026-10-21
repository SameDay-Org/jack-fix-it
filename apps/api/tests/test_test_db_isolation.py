"""The db_session fixture isolates tests: these two run in file order."""

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User, UserRole

FAKE_HASH = "not-a-real-hash"


async def test_isolation_write(db_session: AsyncSession) -> None:
    db_session.add(
        User(email="isolation@example.com", password_hash=FAKE_HASH, role=UserRole.CUSTOMER)
    )
    # A commit inside the test only releases a savepoint; the outer rollback still undoes it.
    await db_session.commit()
    assert await db_session.scalar(select(func.count()).select_from(User)) == 1


async def test_isolation_read(db_session: AsyncSession) -> None:
    assert await db_session.scalar(select(func.count()).select_from(User)) == 0
