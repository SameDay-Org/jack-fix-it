"""Schema of job execution, part 1 (#63): the ETA, the arrival code and its tries, the check-in."""

import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import CHAR, Connection, DateTime, Integer, inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.models import JobStatus
from tests.job_world import build_world, job_row, make_job

MIGRATION = (
    Path(__file__).parents[1] / "alembic" / "versions" / "20261106_4b37f90005dc_job_execution.py"
)
COLUMNS = ("eta_at", "arrival_code", "arrival_code_attempts", "arrival_code_locked_at")
NEW = (*COLUMNS, "checked_in_at")
CHECKS = {"ck_jobs_arrival_code_four_digits", "ck_jobs_arrival_code_attempts_non_negative"}


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("job_execution", MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def job_columns(connection: Connection) -> dict[str, dict[str, Any]]:
    return {column["name"]: dict(column) for column in inspect(connection).get_columns("jobs")}


def job_checks(connection: Connection) -> set[str]:
    return {str(check["name"]) for check in inspect(connection).get_check_constraints("jobs")}


async def test_the_columns(db_session: AsyncSession) -> None:
    columns = await (await db_session.connection()).run_sync(job_columns)

    assert isinstance(columns["eta_at"]["type"], DateTime)
    assert isinstance(columns["arrival_code"]["type"], CHAR)
    assert columns["arrival_code"]["type"].length == 4
    assert isinstance(columns["arrival_code_attempts"]["type"], Integer)
    assert columns["arrival_code_attempts"]["nullable"] is False
    assert columns["arrival_code_attempts"]["default"] == "0"
    for name in ("eta_at", "arrival_code", "arrival_code_locked_at", "checked_in_at"):
        assert columns[name]["nullable"] is True
        assert name == "arrival_code" or isinstance(columns[name]["type"], DateTime)


@pytest.mark.parametrize(
    "fields",
    [{"arrival_code": "12a4"}, {"arrival_code": "123 "}, {"arrival_code_attempts": -1}],
)
async def test_the_checks_refuse_bad_values(
    db_session: AsyncSession, fields: dict[str, object]
) -> None:
    world = await build_world(db_session)
    job = await make_job(db_session, world, JobStatus.ON_THE_WAY)

    for name, value in fields.items():
        setattr(job, name, value)

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.flush()


async def test_a_job_gets_no_code_and_no_tries_by_default(db_session: AsyncSession) -> None:
    world = await build_world(db_session)
    job = await make_job(db_session, world)

    row = await job_row(db_session, job.id)

    assert (row.arrival_code, row.arrival_code_attempts, row.eta_at) == (None, 0, None)


async def test_downgrade_drops_the_columns_and_upgrade_restores_them(
    db_session: AsyncSession,
) -> None:
    # On the test session's transaction, which is rolled back: Postgres DDL is transactional,
    # so the shared test database keeps its head.
    module = migration()

    def after(step: str, connection: Connection) -> tuple[set[str], set[str]]:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, step)()
        return set(job_columns(connection)), job_checks(connection)

    connection = await db_session.connection()
    columns, checks = await connection.run_sync(lambda c: after("downgrade", c))
    assert not set(NEW) & columns
    assert not CHECKS & checks
    columns, checks = await connection.run_sync(lambda c: after("upgrade", c))
    assert set(NEW) <= columns
    assert checks >= CHECKS
