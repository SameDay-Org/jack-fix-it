"""Schema of the job chat (#71): the tables, their constraints and the migration round trip."""

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

from app.modules.chat.models import MESSAGE_MAX_LENGTH, JobChatRead, JobMessage
from app.modules.jobs.models import JobStatus
from tests.job_world import build_world, make_job

MIGRATION = Path(__file__).parents[1] / "alembic" / "versions" / "20261107_e13246f3ed38_job_chat.py"
TABLES = ("job_messages", "job_chat_reads")
INSERT_MESSAGE = text(
    "INSERT INTO job_messages (job_id, sender_id, body, redacted) "
    "VALUES (:job_id, :sender_id, :body, :redacted)"
)


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("job_chat", MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def tables(connection: Connection) -> tuple[bool, ...]:
    inspector = inspect(connection)
    return tuple(inspector.has_table(table) for table in TABLES)


async def test_indexes_and_a_stored_message(db_session: AsyncSession) -> None:
    world = await build_world(db_session)
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    message = JobMessage(job_id=job.id, sender_id=world.pro.id, body="x", redacted=False)
    db_session.add(message)
    await db_session.flush()
    await db_session.refresh(message)

    assert message.created_at is not None

    def names(connection: Connection) -> set[str]:
        inspector = inspect(connection)
        return {str(i["name"]) for table in TABLES for i in inspector.get_indexes(table)}

    indexes = await (await db_session.connection()).run_sync(names)
    assert {
        "ix_job_messages_job_id_created_at",
        "ix_job_messages_sender_id",
        "ix_job_chat_reads_user_id",
        "ix_job_chat_reads_last_read_message_id",
        "uq_job_chat_reads_job_id",
    } <= indexes


@pytest.mark.parametrize(
    "fields",
    [
        {"body": ""},
        {"body": "   \n\t"},
        {"body": "z" * (MESSAGE_MAX_LENGTH + 1)},
        {"body": None},
        {"redacted": None},
        {"job_id": uuid.uuid4()},
        {"sender_id": uuid.uuid4()},
    ],
    ids=["empty", "blank", "too_long", "no_body", "no_redacted", "job_id", "sender_id"],
)
async def test_message_constraints_refuse_bad_rows(
    db_session: AsyncSession, fields: dict[str, object]
) -> None:
    world = await build_world(db_session)
    job = await make_job(db_session, world)
    values: dict[str, object] = {
        "job_id": job.id,
        "sender_id": world.customer.id,
        "body": "ok",
        "redacted": False,
        **fields,
    }

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(INSERT_MESSAGE, values)


async def test_message_accepts_the_longest_body(db_session: AsyncSession) -> None:
    world = await build_world(db_session)
    job = await make_job(db_session, world)

    await db_session.execute(
        INSERT_MESSAGE,
        {
            "job_id": job.id,
            "sender_id": world.customer.id,
            "body": "z" * MESSAGE_MAX_LENGTH,
            "redacted": True,
        },
    )


@pytest.mark.parametrize("bad", ["duplicate", "message", "user", "job"])
async def test_read_marker_constraints(db_session: AsyncSession, bad: str) -> None:
    world = await build_world(db_session)
    job = await make_job(db_session, world)
    message = JobMessage(job_id=job.id, sender_id=world.pro.id, body="x", redacted=False)
    db_session.add(message)
    await db_session.flush()
    db_session.add(
        JobChatRead(
            job_id=job.id,
            user_id=world.customer.id,
            last_read_message_id=message.id,
            last_read_message_at=message.created_at,
        )
    )
    await db_session.flush()
    values = {
        "job_id": job.id,
        "user_id": world.pro.id,
        "message_id": message.id,
        "at": message.created_at,
    }
    if bad == "duplicate":
        values["user_id"] = world.customer.id
    else:
        values[{"message": "message_id", "user": "user_id", "job": "job_id"}[bad]] = uuid.uuid4()

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO job_chat_reads (job_id, user_id, last_read_message_id, "
                    "last_read_message_at) VALUES (:job_id, :user_id, :message_id, :at)"
                ),
                values,
            )


async def test_downgrade_drops_the_tables_and_upgrade_restores_them(
    db_session: AsyncSession,
) -> None:
    # On the test session's transaction, which is rolled back: Postgres DDL is transactional,
    # so the shared test database keeps its head.
    module = migration()

    def after(step: str, connection: Connection) -> tuple[bool, ...]:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, step)()
        return tables(connection)

    connection = await db_session.connection()
    assert module.down_revision == "1f4aa780a8d2"
    assert await connection.run_sync(lambda c: after("downgrade", c)) == (False, False)
    assert await connection.run_sync(lambda c: after("upgrade", c)) == (True, True)
    assert await connection.run_sync(lambda c: after("downgrade", c)) == (False, False)
    assert await connection.run_sync(lambda c: after("upgrade", c)) == (True, True)
