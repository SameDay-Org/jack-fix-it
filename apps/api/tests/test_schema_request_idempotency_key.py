"""Schema of service_requests.idempotency_key and its fingerprint (#264): one request per
customer and key, and a migration the API still serving during the deploy cannot break."""

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

from app.db import violated_constraint
from app.modules.addresses.models import Address
from app.modules.requests.models import IDEMPOTENCY_KEY_INDEX, RequestOrigin, ServiceRequest
from app.modules.users.models import User, UserRole

MIGRATION = (
    Path(__file__).parents[1]
    / "alembic"
    / "versions"
    / "20261113_f0de579f4b29_request_idempotency_key.py"
)
COLUMNS = {"idempotency_key", "idempotency_fingerprint"}


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("request_idempotency_key", MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def address_of_new_customer(session: AsyncSession) -> Address:
    customer = User(
        email=f"customer-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=UserRole.CUSTOMER
    )
    session.add(customer)
    await session.flush()
    address = Address(
        user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
    )
    session.add(address)
    await session.flush()
    return address


def make_request(address: Address, key: uuid.UUID | None) -> ServiceRequest:
    return ServiceRequest(
        customer_id=address.user_id,
        address_id=address.id,
        description="Paint one bedroom",
        origin=RequestOrigin.APP,
        idempotency_key=key,
        idempotency_fingerprint=None if key is None else "0" * 64,
    )


async def test_one_request_per_customer_and_key(db_session: AsyncSession) -> None:
    ana, bob = await address_of_new_customer(db_session), await address_of_new_customer(db_session)
    key = uuid.uuid4()
    # Without a key, as many as wanted; the same key for two customers; one key per customer.
    db_session.add_all(
        [
            make_request(ana, None),
            make_request(ana, None),
            make_request(ana, key),
            make_request(bob, key),
        ]
    )
    await db_session.flush()

    savepoint = await db_session.begin_nested()
    db_session.add(make_request(ana, key))
    with pytest.raises(IntegrityError) as refused:
        await db_session.flush()
    await savepoint.rollback()

    assert violated_constraint(refused.value) == IDEMPOTENCY_KEY_INDEX


def schema(connection: Connection) -> tuple[set[str], dict[str, str]]:
    """The new columns present, and the table's indexes on idempotency_key with their SQL."""
    inspector = inspect(connection)
    columns = {column["name"] for column in inspector.get_columns("service_requests")} & COLUMNS
    definitions = connection.execute(
        text(
            "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'service_requests' "
            "AND indexdef LIKE '%idempotency_key%'"
        )
    )
    return columns, {str(name): str(definition) for name, definition in definitions}


async def test_upgrade_downgrade_upgrade_keeps_old_writers_working(
    db_session: AsyncSession,
) -> None:
    # Run on the test session's transaction, which is rolled back: Postgres DDL is
    # transactional, so the shared test database keeps its head.
    module = migration()
    address = await address_of_new_customer(db_session)

    def step(name: str, connection: Connection) -> tuple[set[str], dict[str, str]]:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, name)()
        return schema(connection)

    async def insert_as_before(request_id: uuid.UUID) -> None:
        """An INSERT as the API before #264 writes one: it names no idempotency column."""
        await db_session.execute(
            text(
                "INSERT INTO service_requests (id, customer_id, address_id, description, origin) "
                "VALUES (:id, :customer, :address, 'Old', 'app')"
            ),
            {"id": request_id, "customer": address.user_id, "address": address.id},
        )

    connection = await db_session.connection()
    upgraded = await connection.run_sync(schema)  # the test database is at head
    assert upgraded[0] == COLUMNS
    assert await connection.run_sync(lambda c: step("downgrade", c)) == (set(), {})

    before = [uuid.uuid4(), uuid.uuid4()]
    for request_id in before:
        await insert_as_before(request_id)
    restored = await connection.run_sync(lambda c: step("upgrade", c))
    # The old API keeps writing while Railway migrates: its inserts still go in.
    during = [uuid.uuid4(), uuid.uuid4()]
    for request_id in during:
        await insert_as_before(request_id)

    assert restored == upgraded
    columns, indexes = restored
    assert columns == COLUMNS
    assert list(indexes) == [IDEMPOTENCY_KEY_INDEX]
    assert indexes[IDEMPOTENCY_KEY_INDEX] == (
        f"CREATE UNIQUE INDEX {IDEMPOTENCY_KEY_INDEX} ON public.service_requests USING btree "
        "(customer_id, idempotency_key) WHERE (idempotency_key IS NOT NULL)"
    )
    rows = await db_session.execute(
        text(
            "SELECT idempotency_key, idempotency_fingerprint FROM service_requests "
            "WHERE id = ANY(:ids)"
        ),
        {"ids": before + during},
    )
    assert rows.all() == [(None, None)] * 4  # no backfill
