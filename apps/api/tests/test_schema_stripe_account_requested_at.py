"""Schema of pro_profiles.stripe_account_requested_at, the payout account's create attempt (#39)."""

import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Any

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Connection, DateTime, inspect
from sqlalchemy.ext.asyncio import AsyncSession

MIGRATION = (
    Path(__file__).parents[1]
    / "alembic"
    / "versions"
    / "20261030_ff6a71f4a729_stripe_account_requested_at.py"
)


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("stripe_account_requested_at", MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def requested_at_column(connection: Connection) -> dict[str, Any] | None:
    columns = {column["name"]: column for column in inspect(connection).get_columns("pro_profiles")}
    column = columns.get("stripe_account_requested_at")
    return None if column is None else dict(column)


def assert_nullable_timestamptz(column: dict[str, Any] | None) -> None:
    assert column is not None
    assert isinstance(column["type"], DateTime)
    assert column["type"].timezone is True
    assert column["nullable"] is True


async def test_requested_at_is_a_nullable_timestamptz(db_session: AsyncSession) -> None:
    connection = await db_session.connection()
    assert_nullable_timestamptz(await connection.run_sync(requested_at_column))


async def test_downgrade_drops_the_column_and_upgrade_restores_it(
    db_session: AsyncSession,
) -> None:
    # Run on the test session's transaction, which is rolled back: Postgres DDL is
    # transactional, so the shared test database keeps its head.
    module = migration()

    def column_after(step: str, connection: Connection) -> dict[str, Any] | None:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, step)()
        return requested_at_column(connection)

    connection = await db_session.connection()
    assert await connection.run_sync(lambda c: column_after("downgrade", c)) is None
    assert_nullable_timestamptz(await connection.run_sync(lambda c: column_after("upgrade", c)))
