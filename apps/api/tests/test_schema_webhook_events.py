"""Schema of webhook_events, the Stripe events recorded once (D7.3, #40)."""

import importlib.util
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Connection, inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.webhooks.models import WebhookEvent, WebhookEventStatus

MIGRATION = (
    Path(__file__).parents[1] / "alembic" / "versions" / "20261030_59585005c91a_webhook_events.py"
)


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("webhook_events", MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def event(**overrides: object) -> WebhookEvent:
    values: dict[str, object] = {
        "stripe_event_id": "evt_schema_1",
        "event_type": "test.event",
        "livemode": False,
        "stripe_created_at": datetime(2026, 10, 30, tzinfo=UTC),
        "status": WebhookEventStatus.PENDING,
        "payload": {"id": "evt_schema_1"},
    }
    values.update(overrides)
    return WebhookEvent(**values)


async def test_defaults(db_session: AsyncSession) -> None:
    row = event()
    db_session.add(row)
    await db_session.flush()
    await db_session.refresh(row)

    assert row.attempts == 0
    assert row.last_error is None
    assert row.processed_at is None
    assert row.created_at is not None


async def test_stripe_event_id_is_unique(db_session: AsyncSession) -> None:
    db_session.add(event())
    await db_session.flush()

    db_session.add(event(event_type="test.other"))
    with pytest.raises(IntegrityError, match="uq_webhook_events_stripe_event_id"):
        await db_session.flush()


async def test_attempts_cannot_be_negative(db_session: AsyncSession) -> None:
    db_session.add(event(attempts=-1))
    with pytest.raises(IntegrityError, match="ck_webhook_events_attempts_non_negative"):
        await db_session.flush()


def table_names(connection: Connection) -> set[str]:
    return set(inspect(connection).get_table_names())


async def test_downgrade_drops_the_table_and_upgrade_restores_it(
    db_session: AsyncSession,
) -> None:
    # Run on the test session's transaction, which is rolled back: Postgres DDL is
    # transactional, so the shared test database keeps its head.
    module = migration()

    def tables_after(step: str, connection: Connection) -> set[str]:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, step)()
        return table_names(connection)

    connection = await db_session.connection()
    assert "webhook_events" not in await connection.run_sync(lambda c: tables_after("downgrade", c))
    assert "webhook_events" in await connection.run_sync(lambda c: tables_after("upgrade", c))
