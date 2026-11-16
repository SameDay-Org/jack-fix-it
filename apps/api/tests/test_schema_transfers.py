"""Schema of the transfers to the pros (#68): transfers, its constraints and indexes, and the
migration round trip. Expand only: Railway migrates while the previous API and worker still
serve, so the upgrade may add this table and change nothing that version knows."""

import importlib.util
from pathlib import Path
from types import ModuleType

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import AsyncSession

from tests.test_schema_reviews import schema

API_DIR = Path(__file__).parents[1]
MIGRATION = API_DIR / "alembic" / "versions" / "20261115_52bb3f92f12b_transfers.py"
TABLE = "transfers"
NAMES = {
    "pk_transfers",
    "fk_transfers_job_id_jobs",
    "fk_transfers_payment_id_payments",
    "fk_transfers_pro_id_pro_profiles",
    "ck_transfers_transfer_status",
    "ck_transfers_made_has_stripe_transfer_id",
    "ck_transfers_amount_cents_positive",
    "ck_transfers_attempts_non_negative",
    "uq_transfers_job_id",
    "uq_transfers_idempotency_key",
    "uq_transfers_stripe_transfer_id",
    "ix_transfers_payment_id",
    "ix_transfers_pro_id",
    "ix_transfers_status",
}


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("transfers", MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def step(session: AsyncSession, name: str) -> None:
    """Runs the migration's upgrade or downgrade on the test session's transaction, which is
    rolled back: Postgres DDL is transactional, so the shared test database keeps its head."""
    module = migration()

    def run(connection: Connection) -> None:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, name)()

    await (await session.connection()).run_sync(run)


async def test_the_table_has_its_named_constraints_and_indexes(db_session: AsyncSession) -> None:
    table = (await (await db_session.connection()).run_sync(schema))[TABLE]

    names = {
        table["primary_key"],
        *table["foreign_keys"],
        *(name for name, _ in table["checks"]),
        *(name for name, _ in table["uniques"]),
        *(name for name, _, _ in table["indexes"]),
    }
    assert names == NAMES
    # One transfer per job: the double-pay guard.
    assert ("uq_transfers_job_id", ("job_id",)) in table["uniques"]
    columns = {name: (type_, nullable) for name, type_, nullable, _ in table["columns"]}
    assert columns["amount_cents"] == ("INTEGER", False)
    assert columns["stripe_transfer_id"] == ("VARCHAR(255)", True)
    assert columns["requested_at"] == ("TIMESTAMP", True)


async def test_the_round_trip_touches_only_the_new_table(db_session: AsyncSession) -> None:
    connection = await db_session.connection()
    at_head = await connection.run_sync(schema)
    others = {name: shape for name, shape in at_head.items() if name != TABLE}

    assert migration().down_revision == "3f4b8f6a2cd8"
    for name in ("downgrade", "upgrade", "downgrade", "upgrade"):
        await step(db_session, name)
        now = await connection.run_sync(schema)
        # Every table the previous version knows is the same on both sides.
        assert {table: shape for table, shape in now.items() if table != TABLE} == others
        assert (TABLE in now) == (name == "upgrade")
    assert (await connection.run_sync(schema))[TABLE] == at_head[TABLE]
    total = await db_session.scalar(text("SELECT count(*) FROM transfers"))
    assert total == 0

