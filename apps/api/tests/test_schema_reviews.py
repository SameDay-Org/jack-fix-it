"""Schema of the two-sided reviews (#77): reviews, its constraints and indexes, and the migration
round trip. Expand only: Railway migrates while the previous API version still serves, so the
upgrade may add this table and change nothing that version knows."""

import importlib.util
import uuid
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import violated_constraint
from app.modules.jobs.models import JobStatus
from app.modules.reviews.models import ONE_PER_AUTHOR, Review, ReviewAuthorRole
from tests.job_world import JobWorld, build_world, make_job

API_DIR = Path(__file__).parents[1]
MIGRATION = API_DIR / "alembic" / "versions" / "20261113_418015ab4aca_reviews.py"
TABLE = "reviews"
COLUMNS = (
    "job_id, author_id, target_id, author_role, overall, communication, quality, punctuality, "
    "value, comment"
)
INSERT = text(
    f"INSERT INTO reviews ({COLUMNS}) VALUES (:job_id, :author_id, :target_id, :author_role, "  # noqa: S608 - fixed column names
    ":overall, :communication, :quality, :punctuality, :value, :comment)"
)
NAMES = {
    "pk_reviews",
    "fk_reviews_job_id_jobs",
    "fk_reviews_author_id_users",
    "fk_reviews_target_id_users",
    "ck_reviews_author_role",
    "ck_reviews_overall_range",
    "ck_reviews_communication_range",
    "ck_reviews_quality_range",
    "ck_reviews_punctuality_range",
    "ck_reviews_value_range",
    "ck_reviews_comment_length",
    "ck_reviews_author_is_not_target",
    "uq_reviews_job_id",
    "ix_reviews_author_id",
    "ix_reviews_target_id_created_at",
}
RATINGS = ("overall", "communication", "quality", "punctuality", "value")


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("reviews", MIGRATION)
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
            "uniques": sorted(
                (str(u["name"]), tuple(u["column_names"]))
                for u in inspector.get_unique_constraints(table)
            ),
            "indexes": sorted(
                (str(i["name"]), tuple(i["column_names"]), bool(i["unique"]))
                for i in inspector.get_indexes(table)
            ),
            "primary_key": inspector.get_pk_constraint(table)["name"],
        }
        for table in inspector.get_table_names()
    }


async def values(session: AsyncSession, world: JobWorld, **changes: Any) -> dict[str, Any]:
    """A good row: the customer's review of the pro of a new confirmed job."""
    job = await make_job(session, world, JobStatus.CONFIRMED)
    good: dict[str, Any] = {
        "job_id": job.id,
        "author_id": world.customer.id,
        "target_id": world.pro.id,
        "author_role": "customer",
        "overall": 5,
        "communication": None,
        "quality": None,
        "punctuality": None,
        "value": None,
        "comment": None,
    }
    return good | changes


async def count(session: AsyncSession) -> int:
    total = await session.scalar(text("SELECT count(*) FROM reviews"))
    assert isinstance(total, int)
    return total


async def test_the_table_has_its_named_constraints_and_indexes(db_session: AsyncSession) -> None:
    def shape(connection: Connection) -> dict[str, Any]:
        table: dict[str, Any] = schema(connection)[TABLE]
        return table

    table = await (await db_session.connection()).run_sync(shape)

    names = {
        table["primary_key"],
        *table["foreign_keys"],
        *(name for name, _ in table["checks"]),
        *(name for name, _ in table["uniques"]),
        *(name for name, _, _ in table["indexes"]),
    }
    assert names == NAMES
    assert table["uniques"] == [(ONE_PER_AUTHOR, ("job_id", "author_id"))]
    assert {
        name: (type_, nullable)
        for name, type_, nullable, _ in table["columns"]
        if name in (*RATINGS, "comment")
    } == {
        "overall": ("SMALLINT", False),
        "communication": ("SMALLINT", True),
        "quality": ("SMALLINT", True),
        "punctuality": ("SMALLINT", True),
        "value": ("SMALLINT", True),
        "comment": ("TEXT", True),
    }


async def test_the_rating_index_is_by_target_newest_first(db_session: AsyncSession) -> None:
    definition = await db_session.scalar(
        text("SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_reviews_target_id_created_at'")
    )

    assert definition is not None
    assert definition.endswith("USING btree (target_id, created_at DESC)")


async def test_a_new_review_reads_back_as_written(db_session: AsyncSession) -> None:
    world = await build_world(db_session)
    job = await make_job(db_session, world, JobStatus.CONFIRMED)
    review = Review(
        job_id=job.id,
        author_id=world.pro.id,
        target_id=world.customer.id,
        author_role=ReviewAuthorRole.PRO,
        overall=4,
    )
    db_session.add(review)
    await db_session.flush()
    await db_session.refresh(review)

    assert (review.overall, review.author_role) == (4, ReviewAuthorRole.PRO)
    assert (review.communication, review.quality, review.punctuality, review.value) == (None,) * 4
    assert review.comment is None
    assert review.created_at == review.updated_at


@pytest.mark.parametrize(
    "good",
    [
        *({column: rating} for column in RATINGS for rating in (1, 5)),
        {"author_role": "pro", "author_id": "pro", "target_id": "customer"},
        {"comment": "x"},
        {"comment": "é" * 1000},
    ],
    ids=lambda good: "+".join(f"{key}={str(value)[:12]}" for key, value in good.items()),
)
async def test_reviews_accept_every_allowed_value(
    db_session: AsyncSession, good: dict[str, Any]
) -> None:
    world = await build_world(db_session)
    parties = {"pro": world.pro.id, "customer": world.customer.id}
    changes = {key: parties[value] if key.endswith("_id") else value for key, value in good.items()}

    await db_session.execute(INSERT, await values(db_session, world, **changes))

    assert await count(db_session) == 1


@pytest.mark.parametrize(
    ("bad", "constraint"),
    [
        *(
            ({column: rating}, f"ck_reviews_{column}_range")
            for column in RATINGS
            for rating in (0, 6, -1)
        ),
        ({"overall": None}, None),  # NOT NULL has no constraint name
        ({"job_id": None}, None),
        ({"author_id": None}, None),
        ({"target_id": None}, None),
        ({"author_role": None}, None),
        ({"author_role": "agent"}, "ck_reviews_author_role"),
        ({"author_role": "admin"}, "ck_reviews_author_role"),
        ({"comment": ""}, "ck_reviews_comment_length"),
        ({"comment": "x" * 1001}, "ck_reviews_comment_length"),
        ({"target_id": "author"}, "ck_reviews_author_is_not_target"),
        ({"job_id": uuid.uuid4()}, "fk_reviews_job_id_jobs"),
        ({"author_id": uuid.uuid4()}, "fk_reviews_author_id_users"),
        ({"target_id": uuid.uuid4()}, "fk_reviews_target_id_users"),
    ],
    ids=lambda case: (
        "+".join(f"{key}={str(value)[:8]!r}" for key, value in case.items())
        if isinstance(case, dict)
        else ""
    ),
)
async def test_reviews_refuse_bad_rows(
    db_session: AsyncSession, bad: dict[str, Any], constraint: str | None
) -> None:
    world = await build_world(db_session)
    row = await values(db_session, world, **bad)
    if row["target_id"] == "author":
        row["target_id"] = row["author_id"]

    with pytest.raises(IntegrityError) as refused:
        async with db_session.begin_nested():
            await db_session.execute(INSERT, row)

    assert violated_constraint(refused.value) == constraint
    assert await count(db_session) == 0


async def test_one_review_per_author_per_job(db_session: AsyncSession) -> None:
    world = await build_world(db_session)
    first = await values(db_session, world)
    await db_session.execute(INSERT, first)

    # The same author on the same job: refused, whatever else differs.
    with pytest.raises(IntegrityError) as refused:
        async with db_session.begin_nested():
            await db_session.execute(INSERT, first | {"overall": 1, "comment": "again"})
    # The other side of that job, and the same author on another job: both fine.
    await db_session.execute(
        INSERT,
        first | {"author_id": world.pro.id, "target_id": world.customer.id, "author_role": "pro"},
    )
    await db_session.execute(INSERT, await values(db_session, world))

    assert violated_constraint(refused.value) == ONE_PER_AUTHOR
    assert await count(db_session) == 3


async def test_the_round_trip_touches_only_the_new_table(db_session: AsyncSession) -> None:
    world = await build_world(db_session)
    await db_session.execute(INSERT, await values(db_session, world))
    connection = await db_session.connection()
    at_head = await connection.run_sync(schema)
    others = {name: shape for name, shape in at_head.items() if name != TABLE}

    assert migration().down_revision == "f0de579f4b29"
    for name in ("downgrade", "upgrade", "downgrade", "upgrade"):
        await step(db_session, name)
        now = await connection.run_sync(schema)
        # Every table the previous version knows is the same on both sides.
        assert {table: shape for table, shape in now.items() if table != TABLE} == others
        assert (TABLE in now) == (name == "upgrade")
    # Up again, the table is exactly the one at head, and empty: the reviews went with it.
    assert (await connection.run_sync(schema))[TABLE] == at_head[TABLE]
    assert await count(db_session) == 0


def test_alembic_has_one_head() -> None:
    config = Config()
    config.set_main_option("script_location", str(API_DIR / "alembic"))

    assert len(ScriptDirectory.from_config(config).get_heads()) == 1
