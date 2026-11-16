"""Schema of pro_profiles' review columns (#41): rejection_reason, reviewed_by and reviewed_at,
in a migration the API still serving during the deploy cannot break."""

import importlib.util
import uuid
from pathlib import Path
from types import ModuleType

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Connection, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from tests.job_world import build_world
from tests.test_schema_pro_profile import make_pro

MIGRATION = (
    Path(__file__).parents[1]
    / "alembic"
    / "versions"
    / "20261115_6fedce2078df_pro_profile_review.py"
)
COLUMNS = {"rejection_reason", "reviewed_by", "reviewed_at"}
FOREIGN_KEY = "fk_pro_profiles_reviewed_by_users"
INDEX = "ix_pro_profiles_reviewed_by"
Schema = tuple[dict[str, bool], set[str], set[str]]


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("pro_profile_review", MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def schema(connection: Connection) -> Schema:
    """The review columns present (name -> nullable), and the table's foreign key and index on
    reviewed_by."""
    inspector = inspect(connection)
    columns = {
        column["name"]: bool(column["nullable"])
        for column in inspector.get_columns("pro_profiles")
        if column["name"] in COLUMNS
    }
    foreign_keys = {
        str(key["name"])
        for key in inspector.get_foreign_keys("pro_profiles")
        if key["constrained_columns"] == ["reviewed_by"]
    }
    indexes = {
        str(index["name"])
        for index in inspector.get_indexes("pro_profiles")
        if index["column_names"] == ["reviewed_by"]
    }
    return columns, foreign_keys, indexes


async def test_the_reviewer_must_be_a_user(db_session: AsyncSession) -> None:
    profile = await make_pro(db_session)

    savepoint = await db_session.begin_nested()
    profile.reviewed_by = uuid.uuid4()
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await savepoint.rollback()


async def test_upgrade_downgrade_upgrade_keeps_old_writers_working(
    db_session: AsyncSession,
) -> None:
    # Run on the test session's transaction, which is rolled back: Postgres DDL is
    # transactional, so the shared test database keeps its head.
    module = migration()
    world = await build_world(db_session)

    def step(name: str, connection: Connection) -> Schema:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, name)()
        return schema(connection)

    async def insert_as_before(user_id: uuid.UUID) -> None:
        """An INSERT as the API before #41 writes one: it names no review column."""
        await db_session.execute(
            text("INSERT INTO pro_profiles (id, user_id) VALUES (:id, :user)"),
            {"id": uuid.uuid4(), "user": user_id},
        )

    assert module.down_revision == "3f4b8f6a2cd8"
    connection = await db_session.connection()
    upgraded = await connection.run_sync(schema)  # the test database is at head
    assert upgraded == (dict.fromkeys(COLUMNS, True), {FOREIGN_KEY}, {INDEX})
    assert await connection.run_sync(lambda c: step("downgrade", c)) == ({}, set(), set())

    await insert_as_before(world.pro_without_profile.id)
    restored = await connection.run_sync(lambda c: step("upgrade", c))
    # The old API keeps writing while Railway migrates: its inserts still go in.
    await insert_as_before(world.customer.id)

    assert restored == upgraded
    rows = await db_session.execute(
        text(
            "SELECT verification_status, rejection_reason, reviewed_by, reviewed_at "
            "FROM pro_profiles WHERE user_id = ANY(:users)"
        ),
        {"users": [world.pro_without_profile.id, world.customer.id]},
    )
    assert rows.all() == [("pending", None, None, None)] * 2  # no backfill
