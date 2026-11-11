"""Schema of the support tickets (#274): support_tickets, its constraints and indexes, and the
migration round trip. Expand only: Railway migrates while the previous API version still
serves, so the upgrade may add this table and change nothing that version knows."""

import importlib.util
import uuid
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Connection, inspect, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.service import AuditService
from app.modules.audit.types import AuditAction, AuditEntity, AuditEntityType
from app.modules.support.models import SupportTicket, TicketPlatform, TicketStatus, TicketTopic
from tests.audit_helpers import audit_rows
from tests.job_world import JobWorld, build_world, make_job

MIGRATION = (
    Path(__file__).parents[1] / "alembic" / "versions" / "20261111_73c9a4e17b60_support_tickets.py"
)
TABLE = "support_tickets"
COLUMNS = (
    "user_id, role, topic, message, job_id, status, closed_at, app_version, platform, created_at"
)
INSERT = text(
    f"INSERT INTO support_tickets ({COLUMNS}) VALUES (:user_id, :role, :topic, :message, "  # noqa: S608 - fixed column names
    ":job_id, :status, :closed_at, :app_version, :platform, COALESCE(:created_at, now()))"
)
NAMES = {
    "pk_support_tickets",
    "fk_support_tickets_user_id_users",
    "fk_support_tickets_job_id_jobs",
    "ck_support_tickets_role",
    "ck_support_tickets_topic",
    "ck_support_tickets_status",
    "ck_support_tickets_platform",
    "ck_support_tickets_message_length",
    "ck_support_tickets_message_not_blank",
    "ck_support_tickets_closed_at_matches_status",
    "ck_support_tickets_app_version_length",
    "ix_support_tickets_user_id_created_at",
    "ix_support_tickets_status_created_at",
    "ix_support_tickets_created_at",
    "ix_support_tickets_job_id",
}


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("support_tickets", MIGRATION)
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


def schema(connection: Connection) -> dict[str, Any]:
    """Every table's columns, constraints and indexes, by table name."""
    inspector = inspect(connection)
    return {
        table: {
            "columns": [
                (c["name"], str(c["type"]), c["nullable"], c["default"])
                for c in inspector.get_columns(table)
            ],
            "checks": sorted(
                (str(c["name"]), str(c["sqltext"])) for c in inspector.get_check_constraints(table)
            ),
            "foreign_keys": sorted(str(f["name"]) for f in inspector.get_foreign_keys(table)),
            "uniques": sorted(str(u["name"]) for u in inspector.get_unique_constraints(table)),
            "indexes": sorted(
                (str(i["name"]), tuple(i["column_names"]), bool(i["unique"]))
                for i in inspector.get_indexes(table)
            ),
            "primary_key": inspector.get_pk_constraint(table)["name"],
        }
        for table in inspector.get_table_names()
    }


def values(world: JobWorld, **changes: Any) -> dict[str, Any]:
    good: dict[str, Any] = {
        "user_id": world.customer.id,
        "role": "customer",
        "topic": "payment",
        "message": "The payment step froze.",
        "job_id": None,
        "status": "open",
        "closed_at": None,
        "app_version": None,
        "platform": None,
        "created_at": None,
    }
    return good | changes


async def test_the_table_has_its_named_constraints_and_indexes(db_session: AsyncSession) -> None:
    def names(connection: Connection) -> set[str | None]:
        table = schema(connection)[TABLE]
        return {
            table["primary_key"],
            *table["foreign_keys"],
            *(name for name, _ in table["checks"]),
            *(name for name, _, _ in table["indexes"]),
        }

    assert await (await db_session.connection()).run_sync(names) == NAMES


async def test_a_new_ticket_is_open_by_default(db_session: AsyncSession) -> None:
    world = await build_world(db_session)
    ticket = SupportTicket(
        user_id=world.pro.id, role="pro", topic=TicketTopic.OTHER, message="Hello"
    )
    db_session.add(ticket)
    await db_session.flush()
    await db_session.refresh(ticket)

    assert (ticket.status, ticket.closed_at, ticket.job_id) == (TicketStatus.OPEN, None, None)
    assert (ticket.app_version, ticket.platform) == (None, None)
    assert ticket.created_at == ticket.updated_at


@pytest.mark.parametrize(
    "good",
    [
        *({"topic": topic.value} for topic in TicketTopic),
        *({"platform": platform.value} for platform in TicketPlatform),
        {"role": "pro"},
        {"status": "in_progress"},
        {"status": "closed", "closed_at": "now"},
        {"message": "x" * 2000},
        {"app_version": "v" * 32},
        {"job_id": "job"},
    ],
    ids=lambda good: "+".join(f"{key}={str(value)[:12]}" for key, value in good.items()),
)
async def test_tickets_accept_every_allowed_value(
    db_session: AsyncSession, good: dict[str, Any]
) -> None:
    world = await build_world(db_session)
    changes = dict(good)
    if changes.get("closed_at") == "now":
        changes["closed_at"] = await db_session.scalar(text("SELECT now()"))
    if changes.get("job_id") == "job":
        changes["job_id"] = (await make_job(db_session, world)).id

    await db_session.execute(INSERT, values(world, **changes))

    assert await db_session.scalar(text("SELECT count(*) FROM support_tickets")) == 1


@pytest.mark.parametrize(
    "bad",
    [
        {"user_id": None},
        {"user_id": uuid.uuid4()},
        {"job_id": uuid.uuid4()},
        {"role": "agent"},
        {"role": "admin"},
        {"role": None},
        {"topic": "billing"},
        {"topic": None},
        {"status": "archived"},
        {"platform": "web"},
        {"message": None},
        {"message": ""},
        {"message": " \n\t"},
        {"message": "x" * 2001},
        {"app_version": ""},
        {"app_version": "v" * 33},
        {"status": "closed"},  # closed without closed_at
        {"closed_at": "now"},  # open with closed_at
        {"status": "in_progress", "closed_at": "now"},
    ],
    ids=lambda bad: "+".join(f"{key}={str(value)[:12]!r}" for key, value in bad.items()),
)
async def test_tickets_refuse_bad_rows(db_session: AsyncSession, bad: dict[str, Any]) -> None:
    world = await build_world(db_session)
    changes = dict(bad)
    if changes.get("closed_at") == "now":
        changes["closed_at"] = await db_session.scalar(text("SELECT now()"))

    # DBAPIError: a too-long app_version is refused by its varchar(32) before the CHECK.
    with pytest.raises((IntegrityError, DBAPIError)):
        async with db_session.begin_nested():
            await db_session.execute(INSERT, values(world, **changes))

    assert await db_session.scalar(text("SELECT count(*) FROM support_tickets")) == 0


async def test_the_round_trip_touches_only_the_new_table(db_session: AsyncSession) -> None:
    world = await build_world(db_session)
    await db_session.execute(INSERT, values(world))
    ticket_id = await db_session.scalar(text("SELECT id FROM support_tickets"))
    # A status change's audit row names the ticket by id, with no foreign key.
    await AuditService(db_session).record_staff_action(
        world.agent.id,
        AuditAction.SUPPORT_TICKET_SET_STATUS,
        AuditEntity(AuditEntityType.SUPPORT_TICKET, ticket_id),
        {"status": "open"},
        {"status": "closed"},
    )
    audited = await audit_rows(db_session)
    connection = await db_session.connection()
    at_head = await connection.run_sync(schema)
    others = {name: shape for name, shape in at_head.items() if name != TABLE}

    assert migration().down_revision == "5286e0060e55"
    for name in ("downgrade", "upgrade", "downgrade", "upgrade"):
        await step(db_session, name)
        now = await connection.run_sync(schema)
        # Every table the previous version knows is the same on both sides.
        assert {table: shape for table, shape in now.items() if table != TABLE} == others
        assert (TABLE in now) == (name == "upgrade")
        # The audit log outlives the table: it is append-only.
        assert await audit_rows(db_session) == audited
    # Up again, the table is exactly the one at head, and empty: the tickets went with it.
    assert (await connection.run_sync(schema))[TABLE] == at_head[TABLE]
    assert await db_session.scalar(text("SELECT count(*) FROM support_tickets")) == 0
