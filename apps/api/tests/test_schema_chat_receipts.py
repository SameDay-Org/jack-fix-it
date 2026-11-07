"""Schema of the chat receipts (#331): the delivered marker on job_chat_reads, its checks and
the migration round trip (backfill on the way up, delivered-only rows dropped on the way down).
"""

import importlib.util
import uuid
from datetime import timedelta
from pathlib import Path
from types import ModuleType

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Connection, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.chat.models import JobMessage
from app.modules.jobs.models import Job
from tests.job_world import JobWorld, build_world, make_job

MIGRATION = (
    Path(__file__).parents[1]
    / "alembic"
    / "versions"
    / "20261107_5286e0060e55_chat_delivered_markers.py"
)
DELIVERED = ("last_delivered_message_id", "last_delivered_message_at")
INSERT_MARKER = text(
    "INSERT INTO job_chat_reads (job_id, user_id, last_read_message_id, last_read_message_at, "
    "last_delivered_message_id, last_delivered_message_at) "
    "VALUES (:job_id, :user_id, :read_id, :read_at, :delivered_id, :delivered_at)"
)


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("chat_delivered_markers", MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def _two_messages(session: AsyncSession) -> tuple[JobWorld, Job, JobMessage, JobMessage]:
    world = await build_world(session)
    job = await make_job(session, world)
    older = JobMessage(job_id=job.id, sender_id=world.pro.id, body="older", redacted=False)
    session.add(older)
    await session.flush()
    await session.refresh(older)
    newer = JobMessage(
        job_id=job.id,
        sender_id=world.pro.id,
        body="newer",
        redacted=False,
        created_at=older.created_at + timedelta(seconds=1),
    )
    session.add(newer)
    await session.flush()
    return world, job, older, newer


async def test_the_delivered_marker_is_indexed(db_session: AsyncSession) -> None:
    def names(connection: Connection) -> set[str]:
        inspector = inspect(connection)
        indexes = {str(i["name"]) for i in inspector.get_indexes("job_chat_reads")}
        checks = {str(c["name"]) for c in inspector.get_check_constraints("job_chat_reads")}
        return indexes | checks

    assert {
        "ix_job_chat_reads_last_delivered_message_id",
        "ck_job_chat_reads_read_complete",
        "ck_job_chat_reads_delivered_covers_read",
    } <= await (await db_session.connection()).run_sync(names)


@pytest.mark.parametrize(
    "bad",
    ["no_delivered", "delivered_half", "read_half", "delivered_behind_read", "delivered_fk"],
)
async def test_marker_checks_refuse_bad_rows(db_session: AsyncSession, bad: str) -> None:
    world, job, older, newer = await _two_messages(db_session)
    values: dict[str, object] = {
        "job_id": job.id,
        "user_id": world.customer.id,
        "read_id": older.id,
        "read_at": older.created_at,
        "delivered_id": newer.id,
        "delivered_at": newer.created_at,
    }
    changes: dict[str, dict[str, object]] = {
        "no_delivered": {"delivered_id": None, "delivered_at": None},
        "delivered_half": {"delivered_at": None},
        "read_half": {"read_at": None},
        "delivered_behind_read": {
            "read_id": newer.id,
            "read_at": newer.created_at,
            "delivered_id": older.id,
            "delivered_at": older.created_at,
        },
        "delivered_fk": {"delivered_id": uuid.uuid4()},
    }
    values |= changes[bad]

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(INSERT_MARKER, values)


async def test_marker_checks_accept_good_rows(db_session: AsyncSession) -> None:
    world, job, _older, newer = await _two_messages(db_session)
    base = {"job_id": job.id, "delivered_id": newer.id, "delivered_at": newer.created_at}
    # Delivered only (a listing), and read at or behind delivered.
    await db_session.execute(
        INSERT_MARKER, {**base, "user_id": world.customer.id, "read_id": None, "read_at": None}
    )
    await db_session.execute(
        INSERT_MARKER,
        {**base, "user_id": world.pro.id, "read_id": newer.id, "read_at": newer.created_at},
    )


async def test_upgrade_backfills_and_downgrade_drops_delivered_only_rows(
    db_session: AsyncSession,
) -> None:
    # On the test session's transaction, which is rolled back: Postgres DDL is transactional,
    # so the shared test database keeps its head.
    world, job, older, newer = await _two_messages(db_session)
    common = {"job_id": job.id, "delivered_id": newer.id, "delivered_at": newer.created_at}
    # The customer read the older message and received the newer; the pro only received it.
    await db_session.execute(
        INSERT_MARKER,
        {**common, "user_id": world.customer.id, "read_id": older.id, "read_at": older.created_at},
    )
    await db_session.execute(
        INSERT_MARKER, {**common, "user_id": world.pro.id, "read_id": None, "read_at": None}
    )
    module = migration()

    def step(name: str, connection: Connection) -> list[tuple[object, ...]]:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, name)()
        columns = {c["name"] for c in inspect(connection).get_columns("job_chat_reads")}
        wanted = ["user_id", "last_read_message_id"] + [c for c in DELIVERED if c in columns]
        # Fixed column names only.
        query = f"SELECT {', '.join(wanted)} FROM job_chat_reads WHERE job_id = :job_id"  # noqa: S608
        rows = connection.execute(text(query), {"job_id": job.id})
        return [tuple(row) for row in rows]

    connection = await db_session.connection()
    assert module.down_revision == "fbd56dcbd642"
    # Down: the delivered columns go, and so does the pro's row, which had no read marker.
    assert await connection.run_sync(lambda c: step("downgrade", c)) == [
        (world.customer.id, older.id)
    ]
    # Up: delivered is backfilled from read.
    [(user_id, read_id, delivered_id, delivered_at)] = await connection.run_sync(
        lambda c: step("upgrade", c)
    )
    assert (user_id, read_id, delivered_id, delivered_at) == (
        world.customer.id,
        older.id,
        older.id,
        older.created_at,
    )
    assert await connection.run_sync(lambda c: step("downgrade", c)) == [
        (world.customer.id, older.id)
    ]
    assert len(await connection.run_sync(lambda c: step("upgrade", c))) == 1
