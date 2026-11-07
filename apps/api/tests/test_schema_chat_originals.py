"""Schema of #72: the original_* columns of job_messages, chat_offender_flags, their constraints
and the migration round trip."""

import importlib.util
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from types import ModuleType

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Connection, inspect, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.chat.repository import ChatRepository
from tests.job_world import JobWorld, build_world, make_job

MIGRATION = (
    Path(__file__).parents[1]
    / "alembic"
    / "versions"
    / "20261107_fbd56dcbd642_chat_originals_and_offender_flags.py"
)
ORIGINAL_COLUMNS = {"original_ciphertext", "original_key_id", "original_expires_at"}
INSERT_MESSAGE = text(
    "INSERT INTO job_messages (job_id, sender_id, body, redacted, original_ciphertext, "
    "original_key_id, original_expires_at) VALUES (:job_id, :sender_id, '•••', :redacted, "
    ":ciphertext, :key_id, :expires_at)"
)
INSERT_FLAG = text(
    "INSERT INTO chat_offender_flags (user_id, job_id, window_count, resolved_at) "
    "VALUES (:user_id, :job_id, :count, :resolved_at)"
)


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("chat_originals", MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def state(connection: Connection) -> tuple[bool, bool]:
    inspector = inspect(connection)
    columns = {str(column["name"]) for column in inspector.get_columns("job_messages")}
    return columns >= ORIGINAL_COLUMNS, inspector.has_table("chat_offender_flags")


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


async def _message_values(session: AsyncSession, world: JobWorld) -> dict[str, object]:
    job = await make_job(session, world)
    now: datetime = await ChatRepository(session).now()
    return {
        "job_id": job.id,
        "sender_id": world.pro.id,
        "redacted": True,
        "ciphertext": b"\x01" * 40,
        "key_id": "k1",
        "expires_at": now + timedelta(days=90),
    }


async def test_a_complete_original_and_none_at_all_are_accepted(
    db_session: AsyncSession, world: JobWorld
) -> None:
    values = await _message_values(db_session, world)
    await db_session.execute(INSERT_MESSAGE, values)
    for redacted in (True, False):
        await db_session.execute(
            INSERT_MESSAGE,
            {
                **values,
                "redacted": redacted,
                "ciphertext": None,
                "key_id": None,
                "expires_at": None,
            },
        )


@pytest.mark.parametrize(
    "fields",
    [
        {"ciphertext": None},
        {"key_id": None},
        {"expires_at": None},
        {"redacted": False},
        {"ciphertext": b"\x01" * 28},
        {"key_id": ""},
    ],
    ids=[
        "no_ciphertext",
        "no_key_id",
        "no_expiry",
        "not_redacted",
        "nonce_and_tag_only",
        "empty_key_id",
    ],
)
async def test_bad_originals_are_refused(
    db_session: AsyncSession, world: JobWorld, fields: dict[str, object]
) -> None:
    values = {**await _message_values(db_session, world), **fields}

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(INSERT_MESSAGE, values)


async def test_a_key_id_longer_than_the_column_is_refused(
    db_session: AsyncSession, world: JobWorld
) -> None:
    values = {**await _message_values(db_session, world), "key_id": "k" * 33}

    # asyncpg reports the truncation as a plain DBAPIError (not DataError).
    with pytest.raises(DBAPIError, match="value too long"):
        async with db_session.begin_nested():
            await db_session.execute(INSERT_MESSAGE, values)


async def test_one_open_flag_per_user_and_any_number_resolved(
    db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    now: datetime = await ChatRepository(db_session).now()
    flag = {"user_id": world.customer.id, "job_id": job.id, "count": 3}
    await db_session.execute(INSERT_FLAG, {**flag, "resolved_at": None})
    for _ in range(2):
        await db_session.execute(INSERT_FLAG, {**flag, "resolved_at": now})

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(INSERT_FLAG, {**flag, "resolved_at": None})


@pytest.mark.parametrize(
    "fields",
    [
        {"count": 0},
        {"user_id": uuid.uuid4()},
        {"job_id": uuid.uuid4()},
        {"resolved_at": "early"},
    ],
    ids=["zero_count", "user_id", "job_id", "resolved_before_created"],
)
async def test_bad_flags_are_refused(
    db_session: AsyncSession, world: JobWorld, fields: dict[str, object]
) -> None:
    job = await make_job(db_session, world)
    now: datetime = await ChatRepository(db_session).now()
    values: dict[str, object] = {
        "user_id": world.customer.id,
        "job_id": job.id,
        "count": 3,
        "resolved_at": None,
        **fields,
    }
    if values["resolved_at"] == "early":
        values["resolved_at"] = now - timedelta(days=1)

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(INSERT_FLAG, values)


async def test_indexes(db_session: AsyncSession) -> None:
    def names(connection: Connection) -> set[str]:
        inspector = inspect(connection)
        tables = ("job_messages", "chat_offender_flags")
        return {str(i["name"]) for table in tables for i in inspector.get_indexes(table)}

    indexes = await (await db_session.connection()).run_sync(names)
    assert {
        "ix_job_messages_original_expires_at",
        "ix_chat_offender_flags_user_id",
        "ix_chat_offender_flags_job_id",
        "uq_chat_offender_flags_open_user_id",
        "ix_chat_offender_flags_created_at",
    } <= indexes


async def test_downgrade_and_upgrade_round_trip(db_session: AsyncSession) -> None:
    # On the test session's transaction, which is rolled back: Postgres DDL is transactional,
    # so the shared test database keeps its head.
    module = migration()

    def after(step: str, connection: Connection) -> tuple[bool, bool]:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, step)()
        return state(connection)

    connection = await db_session.connection()
    assert module.down_revision == "e13246f3ed38"
    assert await connection.run_sync(lambda c: after("downgrade", c)) == (False, False)
    assert await connection.run_sync(lambda c: after("upgrade", c)) == (True, True)
    assert await connection.run_sync(lambda c: after("downgrade", c)) == (False, False)
    assert await connection.run_sync(lambda c: after("upgrade", c)) == (True, True)
