"""Schema of support_tickets.idempotency_key and its fingerprint (#380): one ticket per user
and key, and a migration the API still serving during the deploy cannot break."""

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

from app.db import violated_constraint
from app.modules.support.models import (
    IDEMPOTENCY_KEY_INDEX,
    SupportTicket,
    TicketRole,
    TicketTopic,
)
from tests.job_world import build_world

MIGRATION = (
    Path(__file__).parents[1]
    / "alembic"
    / "versions"
    / "20261113_3f4b8f6a2cd8_support_ticket_idempotency_key.py"
)
COLUMNS = {"idempotency_key", "idempotency_fingerprint"}


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("support_ticket_idempotency_key", MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_ticket(user_id: uuid.UUID, key: uuid.UUID | None) -> SupportTicket:
    return SupportTicket(
        user_id=user_id,
        role=TicketRole.CUSTOMER,
        topic=TicketTopic.OTHER,
        message="Hello",
        idempotency_key=key,
        idempotency_fingerprint=None if key is None else "0" * 64,
    )


async def test_one_ticket_per_user_and_key(db_session: AsyncSession) -> None:
    world = await build_world(db_session)
    ana, bob = world.customer.id, world.other_customer.id
    key = uuid.uuid4()
    # Without a key, as many as wanted; the same key for two users; one key per user.
    db_session.add_all(
        [
            make_ticket(ana, None),
            make_ticket(ana, None),
            make_ticket(ana, key),
            make_ticket(bob, key),
        ]
    )
    await db_session.flush()

    savepoint = await db_session.begin_nested()
    db_session.add(make_ticket(ana, key))
    with pytest.raises(IntegrityError) as refused:
        await db_session.flush()
    await savepoint.rollback()

    assert violated_constraint(refused.value) == IDEMPOTENCY_KEY_INDEX


def schema(connection: Connection) -> tuple[set[str], dict[str, str]]:
    """The new columns present, and the table's indexes on idempotency_key with their SQL."""
    inspector = inspect(connection)
    columns = {column["name"] for column in inspector.get_columns("support_tickets")} & COLUMNS
    definitions = connection.execute(
        text(
            "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'support_tickets' "
            "AND indexdef LIKE '%idempotency_key%'"
        )
    )
    return columns, {str(name): str(definition) for name, definition in definitions}


async def test_upgrade_downgrade_upgrade_keeps_old_writers_working(
    db_session: AsyncSession,
) -> None:
    # Run on the test session's transaction, which is rolled back: Postgres DDL is
    # transactional, so the shared test database keeps its head.
    module = migration()
    world = await build_world(db_session)

    def step(name: str, connection: Connection) -> tuple[set[str], dict[str, str]]:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, name)()
        return schema(connection)

    async def insert_as_before(ticket_id: uuid.UUID) -> None:
        """An INSERT as the API before #380 writes one: it names no idempotency column."""
        await db_session.execute(
            text(
                "INSERT INTO support_tickets (id, user_id, role, topic, message) "
                "VALUES (:id, :user, 'customer', 'other', 'Old')"
            ),
            {"id": ticket_id, "user": world.customer.id},
        )

    assert module.down_revision == "418015ab4aca"
    connection = await db_session.connection()
    upgraded = await connection.run_sync(schema)  # the test database is at head
    assert upgraded[0] == COLUMNS
    assert await connection.run_sync(lambda c: step("downgrade", c)) == (set(), {})

    before = [uuid.uuid4(), uuid.uuid4()]
    for ticket_id in before:
        await insert_as_before(ticket_id)
    restored = await connection.run_sync(lambda c: step("upgrade", c))
    # The old API keeps writing while Railway migrates: its inserts still go in, and two of
    # them by one user never meet in the index (no key, no entry).
    during = [uuid.uuid4(), uuid.uuid4()]
    for ticket_id in during:
        await insert_as_before(ticket_id)

    assert restored == upgraded
    columns, indexes = restored
    assert columns == COLUMNS
    assert list(indexes) == [IDEMPOTENCY_KEY_INDEX]
    assert indexes[IDEMPOTENCY_KEY_INDEX] == (
        f"CREATE UNIQUE INDEX {IDEMPOTENCY_KEY_INDEX} ON public.support_tickets USING btree "
        "(user_id, idempotency_key) WHERE (idempotency_key IS NOT NULL)"
    )
    rows = await db_session.execute(
        text(
            "SELECT idempotency_key, idempotency_fingerprint FROM support_tickets "
            "WHERE id = ANY(:ids)"
        ),
        {"ids": before + during},
    )
    assert rows.all() == [(None, None)] * 4  # no backfill
