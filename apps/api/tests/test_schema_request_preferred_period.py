"""Schema of service_requests.preferred_period, when in the preferred date (#237, ADR 0007)."""

import importlib.util
import uuid
from datetime import date
from pathlib import Path
from types import ModuleType

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Connection, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import violated_constraint
from app.modules.addresses.models import Address
from app.modules.requests.models import PreferredPeriod, RequestOrigin, ServiceRequest
from app.modules.users.models import User, UserRole

MIGRATION = (
    Path(__file__).parents[1]
    / "alembic"
    / "versions"
    / "20261030_cc08e27b820d_request_preferred_period.py"
)
ENUM_CHECK = "ck_service_requests_preferred_period"
NEEDS_DATE_CHECK = "ck_service_requests_preferred_period_needs_date"
DAY = date(2026, 11, 4)


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("request_preferred_period", MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
async def address_of(db_session: AsyncSession) -> Address:
    customer = User(email="customer@x.com", password_hash="x", role=UserRole.CUSTOMER)
    db_session.add(customer)
    await db_session.flush()
    address = Address(
        user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
    )
    db_session.add(address)
    await db_session.flush()
    return address


def make_request(address: Address, **overrides: object) -> ServiceRequest:
    values: dict[str, object] = {
        "customer_id": address.user_id,
        "address_id": address.id,
        "description": "Paint one bedroom",
        "origin": RequestOrigin.APP,
    }
    values.update(overrides)
    return ServiceRequest(**values)


async def assert_refused_by(session: AsyncSession, constraint: str, row: ServiceRequest) -> None:
    savepoint = await session.begin_nested()
    session.add(row)
    with pytest.raises(IntegrityError) as refused:
        await session.flush()
    await savepoint.rollback()
    assert violated_constraint(refused.value) == constraint


@pytest.mark.parametrize("period", list(PreferredPeriod))
async def test_period_without_date_is_refused_by_the_database(
    db_session: AsyncSession, address_of: Address, period: PreferredPeriod
) -> None:
    await assert_refused_by(
        db_session, NEEDS_DATE_CHECK, make_request(address_of, preferred_period=period)
    )


async def test_removing_the_date_of_a_period_is_refused(
    db_session: AsyncSession, address_of: Address
) -> None:
    request = make_request(address_of, preferred_date=DAY, preferred_period=PreferredPeriod.MORNING)
    db_session.add(request)
    await db_session.flush()

    savepoint = await db_session.begin_nested()
    with pytest.raises(IntegrityError) as refused:
        await db_session.execute(
            text("UPDATE service_requests SET preferred_date = NULL WHERE id = :id"),
            {"id": request.id},
        )
    await savepoint.rollback()
    assert violated_constraint(refused.value) == NEEDS_DATE_CHECK


async def test_unknown_period_is_refused_by_the_database(
    db_session: AsyncSession, address_of: Address
) -> None:
    request = make_request(address_of, preferred_date=DAY)
    db_session.add(request)
    await db_session.flush()

    savepoint = await db_session.begin_nested()
    with pytest.raises(IntegrityError) as refused:
        await db_session.execute(
            text("UPDATE service_requests SET preferred_period = 'night' WHERE id = :id"),
            {"id": request.id},
        )
    await savepoint.rollback()
    assert violated_constraint(refused.value) == ENUM_CHECK


async def test_every_period_with_a_date_and_none_without_are_accepted(
    db_session: AsyncSession, address_of: Address
) -> None:
    # The migration's enum CHECK is written by hand; every StrEnum member must pass it.
    db_session.add_all(
        make_request(address_of, preferred_date=DAY, preferred_period=period)
        for period in PreferredPeriod
    )
    db_session.add(make_request(address_of))
    db_session.add(make_request(address_of, preferred_date=DAY))  # as stored before #237
    await db_session.flush()


def checks_and_column(connection: Connection) -> tuple[set[str], bool]:
    inspector = inspect(connection)
    checks = {
        str(check["name"])
        for check in inspector.get_check_constraints("service_requests")
        if "preferred_period" in str(check["name"])
    }
    columns = {column["name"] for column in inspector.get_columns("service_requests")}
    return checks, "preferred_period" in columns


async def test_downgrade_drops_the_column_and_upgrade_keeps_existing_rows_null(
    db_session: AsyncSession, address_of: Address
) -> None:
    # Run on the test session's transaction, which is rolled back: Postgres DDL is
    # transactional, so the shared test database keeps its head.
    module = migration()

    def step(name: str, connection: Connection) -> tuple[set[str], bool]:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, name)()
        return checks_and_column(connection)

    connection = await db_session.connection()
    assert await connection.run_sync(lambda c: step("downgrade", c)) == (set(), False)

    # A request stored before the upgrade, with a date.
    request_id = uuid.uuid4()
    await db_session.execute(
        text(
            "INSERT INTO service_requests (id, customer_id, address_id, description, "
            "preferred_date, origin) VALUES (:id, :customer, :address, 'Old', :day, 'app')"
        ),
        {
            "id": request_id,
            "customer": address_of.user_id,
            "address": address_of.id,
            "day": DAY,
        },
    )

    restored = await connection.run_sync(lambda c: step("upgrade", c))

    assert restored == ({ENUM_CHECK, NEEDS_DATE_CHECK}, True)
    period = await db_session.scalar(
        text("SELECT preferred_period FROM service_requests WHERE id = :id"), {"id": request_id}
    )
    assert period is None  # no backfill
