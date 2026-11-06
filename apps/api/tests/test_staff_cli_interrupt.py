"""Gatekeeper round 4 B3 (#58): Ctrl-C while a staff CLI rolls back a refused audit insert.

The refused INSERT's error chains PostgreSQL's DETAIL (the failing row: the reason, the
operator's choice of words, a Stripe id), which hide_parameters does not hide. Interrupted
there, the CLI used to die with Python's traceback of that chain. Each case runs the CLI's real
`main()` in a child process (tests/staff_cli_interrupt_child.py) on a fresh database with a
real SIGINT, and reads what the process printed.
"""

import asyncio
import io
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import pool, text
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from scripts.staff_operator import run_to_exit
from tests.conftest import API_DIR, _create_database_if_missing
from tests.staff_cli_interrupt_child import ACCOUNT, REASON
from tests.test_resolve_payment_intent import INTENT
from tests.test_resolve_payment_intent import stored as stored_payment
from tests.test_resolve_payout_account import stored as stored_profile

CHILD_TIMEOUT_SECONDS = 120


async def _drop(url: URL) -> None:
    engine = create_async_engine(
        url.set(database="postgres"), isolation_level="AUTOCOMMIT", poolclass=pool.NullPool
    )
    try:
        async with engine.connect() as connection:
            name = connection.dialect.identifier_preparer.quote(str(url.database))
            await connection.execute(text(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)"))
    finally:
        await engine.dispose()


@pytest.fixture
def fresh_database(test_database_url: URL) -> URL:
    """<test database>_interrupt, recreated and migrated: the child commits fixed emails and
    a constraint refusing every audit insert."""
    url = test_database_url.set(database=f"{test_database_url.database}_interrupt")
    asyncio.run(_drop(url))
    asyncio.run(_create_database_if_missing(url))
    config = Config()
    config.set_main_option("script_location", str(API_DIR / "alembic"))
    config.attributes["database_url"] = url.render_as_string(hide_password=False)
    command.upgrade(config, "head")
    return url


async def _state(url: URL, domain: str, entity: uuid.UUID) -> tuple[list[str | None], int]:
    engine = create_async_engine(url, poolclass=pool.NullPool)
    try:
        async with async_sessionmaker(engine, class_=AsyncSession)() as session:
            stored = stored_payment if domain == "payment" else stored_profile
            now = await stored(session, entity)
            audits = await session.scalar(text("SELECT count(*) FROM audit_log"))
            return [None if v is None else str(v) for v in now], int(audits or 0)
    finally:
        await engine.dispose()


@pytest.mark.parametrize("point", ["rollback", "prompt"])
@pytest.mark.parametrize(
    ("domain", "entity", "stripe_id"),
    [("payment", "payment", INTENT), ("payout", "pro profile", ACCOUNT)],
)
def test_ctrl_c_prints_the_safe_line_only_and_exits_130(
    fresh_database: URL, tmp_path: Path, domain: str, entity: str, stripe_id: str, point: str
) -> None:
    """At the rollback of a refused audit insert, and at the prompt left unanswered (its
    thread must not hold the process: asyncio.to_thread's did, for good)."""
    ids_path = tmp_path / "ids.json"
    env = {
        **os.environ,
        "STAFF_CLI_INTERRUPT_DATABASE_URL": fresh_database.render_as_string(hide_password=False),
        "PYTHONIOENCODING": "utf-8",
    }
    result = subprocess.run(  # noqa: S603 - fixed arguments, test fixture
        [sys.executable, "-m", "tests.staff_cli_interrupt_child", domain, point, str(ids_path)],
        cwd=API_DIR,
        stdin=subprocess.DEVNULL,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=CHILD_TIMEOUT_SECONDS,
        check=False,
    )
    output = result.stdout + result.stderr

    assert result.returncode == 130, output[-2000:]
    for leaked in (REASON, "person-sigint@", stripe_id, "Failing row", "INSERT", "Traceback"):
        assert leaked not in output
    lines = result.stdout.splitlines()
    assert lines[-1] == (
        "Interrupted: the run stopped before it finished. The change and its audit row are "
        f"saved together or not at all: check the {entity} before running this again."
    )
    logs = [json.loads(line) for line in lines if line.startswith("{")]
    assert [log.get("entity") for log in logs if log["message"] == "staff_script_interrupted"] == [
        entity
    ]
    assert all("exception" not in log for log in logs)

    ids = json.loads(ids_path.read_text(encoding="utf-8"))
    assert asyncio.run(_state(fresh_database, domain, uuid.UUID(ids["entity"]))) == (
        ids["before"],
        0,
    )


def test_the_boundary_keeps_exit_codes_and_argparse_exits() -> None:
    async def done() -> int:
        return 0

    async def bad_flags() -> int:
        raise SystemExit(2)

    out = io.StringIO()
    assert run_to_exit(done, entity="payment", out=out) == 0
    with pytest.raises(SystemExit) as exited:
        run_to_exit(bad_flags, entity="payment", out=out)
    assert exited.value.code == 2
    assert out.getvalue() == ""


def test_any_other_base_exception_prints_its_class_only() -> None:
    async def cancelled() -> int:
        try:
            raise RuntimeError(REASON)
        except RuntimeError as error:
            raise asyncio.CancelledError(REASON) from error

    out = io.StringIO()
    assert run_to_exit(cancelled, entity="payment", out=out) == 1
    assert out.getvalue() == (
        "Error: the run failed (error_class=CancelledError). The change and its audit row are "
        "saved together or not at all: check the payment before running this again.\n"
    )
