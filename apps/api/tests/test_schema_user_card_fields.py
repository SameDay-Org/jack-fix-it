"""Schema of the ID card's columns on users (#250 part 1, #290, ADR 0007), and their migration."""

import importlib.util
import re
import uuid
from pathlib import Path
from types import ModuleType

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Connection, inspect, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users import public_codes
from app.modules.users.locations import US_STATE_CODES
from app.modules.users.models import User
from app.modules.users.types import UserRole
from tests.test_schema_core import assert_rejected

MIGRATION = (
    Path(__file__).parents[1] / "alembic" / "versions" / "20261105_b3e5a9c17d42_user_card_fields.py"
)
CARD_COLUMNS = {"public_code", "home_city", "home_state", "photo_key"}
CARD_CONSTRAINTS = {
    "uq_users_public_code",
    "ck_users_public_code_crockford",
    "ck_users_home_state_us",
    "ck_users_home_together",
}
CODE = re.compile(public_codes.PATTERN)


def user(**columns: object) -> User:
    return User(
        email=f"u-{uuid.uuid4().hex[:8]}@x.com",
        password_hash="x",
        role=UserRole.CUSTOMER,
        **columns,
    )


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("user_card_fields", MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def test_every_orm_insert_gets_a_public_code(db_session: AsyncSession) -> None:
    rows = [user() for _ in range(5)]
    db_session.add_all(rows)
    await db_session.flush()

    codes = {row.public_code for row in rows}
    assert len(codes) == 5
    assert all(CODE.fullmatch(code) for code in codes)


async def test_public_code_is_required_and_unique(db_session: AsyncSession) -> None:
    first = user(public_code="ABCD2345")
    db_session.add(first)
    await db_session.flush()

    await assert_rejected(db_session, user(public_code="ABCD2345"))
    savepoint = await db_session.begin_nested()
    with pytest.raises(IntegrityError):
        await db_session.execute(
            text(
                "INSERT INTO users (email, password_hash, role) VALUES ('nocode@x.com', 'x', 'pro')"
            )
        )
    await savepoint.rollback()


@pytest.mark.parametrize(
    "code",
    [
        "abcd2345",  # lower case
        "ABCDEFGI",  # I
        "ABCDEFGL",  # L
        "ABCDEFGO",  # O
        "ABCDEFGU",  # U
        "ABCD234",  # 7 characters
        "ABCD-234",
        "",
    ],
)
async def test_public_code_must_be_crockford(db_session: AsyncSession, code: str) -> None:
    await assert_rejected(db_session, user(public_code=code))


async def test_home_state_accepts_every_state_and_dc(db_session: AsyncSession) -> None:
    rows = [user(home_city="Testville", home_state=code) for code in sorted(US_STATE_CODES)]
    db_session.add_all(rows)
    await db_session.flush()

    assert len(rows) == 51


@pytest.mark.parametrize(
    "columns",
    [
        {"home_city": "Testville", "home_state": "ZZ"},
        {"home_city": "Testville", "home_state": "fl"},
        {"home_city": "Testville", "home_state": "PR"},
        {"home_city": "Testville", "home_state": None},
        {"home_city": None, "home_state": "FL"},
    ],
)
async def test_home_city_and_state_checks(
    db_session: AsyncSession, columns: dict[str, object]
) -> None:
    await assert_rejected(db_session, user(**columns))


async def test_card_columns_are_nullable_and_empty_by_default(db_session: AsyncSession) -> None:
    row = user()
    db_session.add(row)
    await db_session.flush()
    await db_session.refresh(row)

    assert (row.home_city, row.home_state, row.photo_key) == (None, None, None)


def test_migration_repeats_the_apps_alphabet_and_states() -> None:
    # The migration keeps its own copies (it must not change with the app); they match today.
    module = migration()

    assert module.PUBLIC_CODE_ALPHABET == public_codes.ALPHABET
    assert module.PUBLIC_CODE_LENGTH == public_codes.LENGTH
    assert module.PUBLIC_CODE_PATTERN == public_codes.PATTERN
    assert set(module.US_STATE_CODES) == US_STATE_CODES
    assert len(module.US_STATE_CODES) == len(US_STATE_CODES) == 51


async def test_migration_backfills_public_codes(db_session: AsyncSession) -> None:
    # Run on the test session's transaction, which is rolled back: Postgres DDL is
    # transactional, so the shared test database keeps its head.
    module = migration()

    def run(step: str, connection: Connection) -> None:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, step)()

    def columns(connection: Connection) -> set[str]:
        return {column["name"] for column in inspect(connection).get_columns("users")}

    def constraints(connection: Connection) -> set[str]:
        inspector = inspect(connection)
        names = {str(c["name"]) for c in inspector.get_unique_constraints("users")}
        return names | {str(c["name"]) for c in inspector.get_check_constraints("users")}

    connection = await db_session.connection()
    await connection.run_sync(lambda c: run("downgrade", c))
    assert CARD_COLUMNS.isdisjoint(await connection.run_sync(columns))
    assert CARD_CONSTRAINTS.isdisjoint(await connection.run_sync(constraints))
    # Accounts from before the card: nothing to copy a code from.
    emails = [f"old-{index}-{uuid.uuid4().hex[:6]}@x.com" for index in range(3)]
    for email in emails:
        await db_session.execute(
            text("INSERT INTO users (email, password_hash, role) VALUES (:email, 'x', 'customer')"),
            {"email": email},
        )

    await connection.run_sync(lambda c: run("upgrade", c))

    assert await connection.run_sync(columns) >= CARD_COLUMNS
    assert await connection.run_sync(constraints) >= CARD_CONSTRAINTS
    codes = (await db_session.scalars(select(User.public_code).where(User.email.in_(emails)))).all()
    assert len(codes) == 3
    assert len(set(codes)) == 3
    assert all(CODE.fullmatch(code) for code in codes)
    # The constraints are back: a duplicate is refused, and new rows draw their own codes.
    await assert_rejected(db_session, user(public_code=codes[0]))
    fresh = user()
    db_session.add(fresh)
    await db_session.flush()
    assert CODE.fullmatch(fresh.public_code)
    assert fresh.public_code not in codes
