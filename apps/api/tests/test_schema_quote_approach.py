"""Schema of quotes.approach, the "How I'll do the job" note (#246)."""

import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Any

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Connection, Text, inspect, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.settings.models import Setting

MIGRATION = (
    Path(__file__).parents[1] / "alembic" / "versions" / "20261029_7675e571942e_quote_approach.py"
)


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("quote_approach", MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def approach_column(connection: Connection) -> dict[str, Any] | None:
    columns = {column["name"]: column for column in inspect(connection).get_columns("quotes")}
    return dict(columns["approach"]) if "approach" in columns else None


async def test_approach_is_a_nullable_text_column(db_session: AsyncSession) -> None:
    column = await (await db_session.connection()).run_sync(approach_column)

    assert column is not None
    assert isinstance(column["type"], Text)
    assert column["nullable"] is True


async def test_the_take_rate_is_not_seeded(db_session: AsyncSession) -> None:
    """The code default (1500) applies until an admin stores a row."""
    key = await db_session.scalar(
        select(Setting.key).where(Setting.key == "platform_take_rate_bps")
    )

    assert key is None


async def test_downgrade_drops_the_column_and_upgrade_restores_it(
    db_session: AsyncSession,
) -> None:
    # Run on the test session's transaction, which is rolled back: Postgres DDL is
    # transactional, so the shared test database keeps its head.
    module = migration()

    def column_after(step: str, connection: Connection) -> dict[str, Any] | None:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, step)()
        return approach_column(connection)

    connection = await db_session.connection()
    assert await connection.run_sync(lambda c: column_after("downgrade", c)) is None
    restored = await connection.run_sync(lambda c: column_after("upgrade", c))
    assert restored is not None
    assert restored["nullable"] is True
