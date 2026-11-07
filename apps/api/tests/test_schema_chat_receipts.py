"""Schema of the chat receipts (#331): job_chat_deliveries, its constraints, the migration round
trip, and the API version before it working against it (Railway migrates while that version
still serves, and it keeps serving when the new one fails)."""

import importlib.util
import uuid
from collections.abc import Collection
from datetime import timedelta
from pathlib import Path
from types import ModuleType

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Connection, and_, func, inspect, or_, select, text, tuple_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.chat.models import JobChatRead, JobMessage
from app.modules.chat.repository import ChatRepository
from app.modules.jobs.models import Job
from tests.job_world import JobWorld, build_world, make_job

MIGRATION = (
    Path(__file__).parents[1]
    / "alembic"
    / "versions"
    / "20261107_5286e0060e55_chat_delivered_markers.py"
)
TABLE = "job_chat_deliveries"
INSERT_DELIVERY = text(
    "INSERT INTO job_chat_deliveries (job_id, user_id, last_delivered_message_id, "
    "last_delivered_message_at) VALUES (:job_id, :user_id, :message_id, :message_at)"
)


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("chat_delivered_markers", MIGRATION)
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


async def test_the_delivered_markers_are_indexed_and_unique(db_session: AsyncSession) -> None:
    def names(connection: Connection) -> set[str]:
        inspector = inspect(connection)
        indexes = {str(i["name"]) for i in inspector.get_indexes(TABLE)}
        uniques = {str(u["name"]) for u in inspector.get_unique_constraints(TABLE)}
        return indexes | uniques

    assert {
        "ix_job_chat_deliveries_last_delivered_message_id",
        "ix_job_chat_deliveries_user_id",
        "uq_job_chat_deliveries_job_id",
    } <= await (await db_session.connection()).run_sync(names)


@pytest.mark.parametrize("bad", ["no_message", "no_message_at", "unknown_message", "second_row"])
async def test_delivered_markers_refuse_bad_rows(db_session: AsyncSession, bad: str) -> None:
    world, job, older, newer = await _two_messages(db_session)
    good = {
        "job_id": job.id,
        "user_id": world.customer.id,
        "message_id": older.id,
        "message_at": older.created_at,
    }
    changes: dict[str, dict[str, object]] = {
        "no_message": {"message_id": None},
        "no_message_at": {"message_at": None},
        "unknown_message": {"message_id": uuid.uuid4()},
        "second_row": {"message_id": newer.id, "message_at": newer.created_at},
    }
    if bad == "second_row":
        await db_session.execute(INSERT_DELIVERY, good)

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(INSERT_DELIVERY, good | changes[bad])


async def test_the_round_trip_keeps_the_read_markers(db_session: AsyncSession) -> None:
    world, job, older, newer = await _two_messages(db_session)
    # The customer read the older message and received the newer.
    await ChatRepository(db_session).move_read(job.id, world.customer.id, older)
    await ChatRepository(db_session).move_delivered(job.id, world.customer.id, newer)

    def shape(connection: Connection) -> tuple[bool, list[tuple[str, bool]]]:
        inspector = inspect(connection)
        columns = [(c["name"], c["nullable"]) for c in inspector.get_columns("job_chat_reads")]
        return inspector.has_table(TABLE), columns

    async def reads() -> list[tuple[object, ...]]:
        query = text("SELECT user_id, last_read_message_id FROM job_chat_reads WHERE job_id = :j")
        return [tuple(r) for r in await db_session.execute(query, {"j": job.id})]

    connection = await db_session.connection()
    at_head = await connection.run_sync(shape)
    assert migration().down_revision == "fbd56dcbd642"
    for name in ("downgrade", "upgrade", "downgrade", "upgrade"):
        await step(db_session, name)
        has_deliveries, read_columns = await connection.run_sync(shape)
        # job_chat_reads is the same on both sides: the previous version's table.
        assert (has_deliveries, read_columns) == (name == "upgrade", at_head[1])
        assert await reads() == [(world.customer.id, older.id)]
    # The delivered markers went with the table; up again, they start empty.
    count = await db_session.scalar(text("SELECT count(*) FROM job_chat_deliveries"))
    assert count == 0


# The API version before #331, against this schema


class PreviousChatRepository:
    """The read marker queries of ChatRepository as deployed before #331 (develop b1bd9e4),
    verbatim: the version still serving while this migration runs."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def move_marker(self, job_id: uuid.UUID, user_id: uuid.UUID, message: JobMessage) -> None:
        statement = insert(JobChatRead).values(
            job_id=job_id,
            user_id=user_id,
            last_read_message_id=message.id,
            last_read_message_at=message.created_at,
        )
        statement = statement.on_conflict_do_update(
            index_elements=[JobChatRead.job_id, JobChatRead.user_id],
            set_={
                "last_read_message_id": statement.excluded.last_read_message_id,
                "last_read_message_at": statement.excluded.last_read_message_at,
                "updated_at": func.now(),
            },
            where=tuple_(JobChatRead.last_read_message_at, JobChatRead.last_read_message_id)
            < tuple_(
                statement.excluded.last_read_message_at, statement.excluded.last_read_message_id
            ),
        )
        await self._session.execute(statement)

    async def unread_counts(
        self, job_ids: Collection[uuid.UUID], user_id: uuid.UUID
    ) -> dict[uuid.UUID, int]:
        if not job_ids:
            return {}
        marker = JobChatRead
        statement = (
            select(JobMessage.job_id, func.count())
            .select_from(JobMessage)
            .outerjoin(marker, and_(marker.job_id == JobMessage.job_id, marker.user_id == user_id))
            .where(
                JobMessage.job_id.in_(job_ids),
                JobMessage.sender_id != user_id,
                or_(
                    marker.id.is_(None),
                    tuple_(JobMessage.created_at, JobMessage.id)
                    > tuple_(marker.last_read_message_at, marker.last_read_message_id),
                ),
            )
            .group_by(JobMessage.job_id)
        )
        return {job_id: count for job_id, count in await self._session.execute(statement)}


@pytest.mark.parametrize("upgraded", [False, True], ids=["before", "after"])
@pytest.mark.parametrize("existing", [False, True], ids=["new_marker", "existing_marker"])
async def test_the_previous_version_moves_read_markers(
    db_session: AsyncSession, upgraded: bool, existing: bool
) -> None:
    # Before the upgrade: the control. After it: the previous version still serving.
    world, job, older, newer = await _two_messages(db_session)
    await step(db_session, "downgrade")
    previous = PreviousChatRepository(db_session)
    if existing:
        await previous.move_marker(job.id, world.customer.id, older)
    if upgraded:
        await step(db_session, "upgrade")

    await previous.move_marker(job.id, world.customer.id, newer)

    assert (await previous.unread_counts([job.id], world.customer.id)).get(job.id, 0) == 0


async def test_the_previous_version_counts_unread_past_a_new_delivered_marker(
    db_session: AsyncSession,
) -> None:
    # The new version lists the thread (delivered) and the customer reads the older message;
    # the previous version's unread count for the same customer stays right.
    world, job, older, newer = await _two_messages(db_session)
    repository, previous = ChatRepository(db_session), PreviousChatRepository(db_session)

    await repository.move_delivered(job.id, world.customer.id, newer)
    assert (await previous.unread_counts([job.id], world.customer.id))[job.id] == 2
    await repository.move_read(job.id, world.customer.id, older)
    assert (await previous.unread_counts([job.id], world.customer.id))[job.id] == 1
    # And a read marker the previous version moves is the one the new version reads.
    await previous.move_marker(job.id, world.customer.id, newer)
    assert await repository.unread_counts([job.id], world.customer.id) == {}
