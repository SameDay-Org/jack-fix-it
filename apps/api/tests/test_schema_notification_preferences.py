"""Schema of notification_preferences (D13, #217, ADR 0007)."""

import importlib.util
import uuid
from pathlib import Path
from types import ModuleType

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Connection, delete, inspect, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications.models import NotificationPreference
from app.modules.users.models import User
from app.modules.users.types import UserRole
from tests.test_schema_core import assert_rejected

MIGRATION = (
    Path(__file__).parents[1]
    / "alembic"
    / "versions"
    / "20261028_d0bc3353ce35_notification_preferences.py"
)


async def user(session: AsyncSession) -> uuid.UUID:
    row = User(email=f"u-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=UserRole.PRO)
    session.add(row)
    await session.flush()
    return row.id


def preference(
    user_id: uuid.UUID,
    group: str = "marketing",
    channel: str = "email",
    enabled: bool | None = True,
) -> NotificationPreference:
    return NotificationPreference(user_id=user_id, group=group, channel=channel, enabled=enabled)


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("notification_preferences", MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def test_primary_key_is_user_group_channel(db_session: AsyncSession) -> None:
    ana, bruno = await user(db_session), await user(db_session)
    db_session.add_all(
        [
            preference(ana),
            preference(ana, channel="push"),
            preference(ana, "reminders", channel="push"),
            preference(bruno),
        ]
    )
    await db_session.flush()

    await assert_rejected(db_session, preference(ana))
    pk = await (await db_session.connection()).run_sync(
        lambda c: inspect(c).get_pk_constraint("notification_preferences")
    )
    assert pk["constrained_columns"] == ["user_id", "group", "channel"]


async def test_required_columns_and_timestamps(db_session: AsyncSession) -> None:
    ana = await user(db_session)
    await assert_rejected(db_session, preference(ana, enabled=None))
    await assert_rejected(db_session, preference(uuid.uuid4()))  # the user must exist
    row = preference(ana)
    db_session.add(row)
    await db_session.flush()
    await db_session.refresh(row)

    assert row.created_at is not None
    assert row.updated_at is not None


async def test_deleting_the_user_deletes_their_preferences(db_session: AsyncSession) -> None:
    ana, bruno = await user(db_session), await user(db_session)
    db_session.add_all([preference(ana), preference(bruno)])
    await db_session.flush()
    db_session.expunge_all()

    await db_session.execute(delete(User).where(User.id == ana))

    owners = (await db_session.scalars(select(NotificationPreference.user_id))).all()
    assert ana not in owners
    assert bruno in owners


async def test_downgrade_drops_the_table_and_upgrade_restores_it(
    db_session: AsyncSession,
) -> None:
    # Run on the test session's transaction, which is rolled back: Postgres DDL is
    # transactional, so the shared test database keeps its head.
    module = migration()

    def tables_after(step: str, connection: Connection) -> set[str]:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, step)()
        return set(inspect(connection).get_table_names())

    connection = await db_session.connection()
    assert "notification_preferences" not in await connection.run_sync(
        lambda c: tables_after("downgrade", c)
    )
    assert "notification_preferences" in await connection.run_sync(
        lambda c: tables_after("upgrade", c)
    )
    ana = await user(db_session)
    db_session.add(preference(ana))
    await db_session.flush()
    await assert_rejected(db_session, preference(ana))
