"""Schema of settings and request_dispatches (D9.1, #48, ADR 0007)."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import Connection, inspect, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.addresses.models import Address
from app.modules.dispatch.models import DispatchStatus, RequestDispatch
from app.modules.pros.models import ProProfile
from app.modules.requests.models import RequestOrigin, ServiceRequest
from app.modules.settings.models import Setting
from app.modules.users.models import User, UserRole
from tests.test_schema_core import assert_rejected

NOW = datetime(2026, 10, 22, 12, 0, tzinfo=UTC)


@pytest.fixture
async def ids(db_session: AsyncSession) -> tuple[uuid.UUID, uuid.UUID]:
    """A request and a pro profile to dispatch it to."""
    customer = User(email="customer@x.com", password_hash="x", role=UserRole.CUSTOMER)
    pro = User(email="pro@x.com", password_hash="x", role=UserRole.PRO)
    db_session.add_all([customer, pro])
    await db_session.flush()
    address = Address(
        user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
    )
    profile = ProProfile(user_id=pro.id)
    db_session.add_all([address, profile])
    await db_session.flush()
    request = ServiceRequest(
        customer_id=customer.id,
        address_id=address.id,
        description="Fix a leak",
        origin=RequestOrigin.APP,
    )
    db_session.add(request)
    await db_session.flush()
    return request.id, profile.id


async def test_dispatch_status_defaults_to_sent(
    db_session: AsyncSession, ids: tuple[uuid.UUID, uuid.UUID]
) -> None:
    request_id, pro_id = ids
    row = RequestDispatch(request_id=request_id, pro_id=pro_id, sent_at=NOW)
    db_session.add(row)
    await db_session.flush()
    await db_session.refresh(row)

    assert row.status is DispatchStatus.SENT
    assert row.responded_at is None


async def test_dispatch_status_check(
    db_session: AsyncSession, ids: tuple[uuid.UUID, uuid.UUID]
) -> None:
    request_id, pro_id = ids
    db_session.add(RequestDispatch(request_id=request_id, pro_id=pro_id, sent_at=NOW))
    await db_session.flush()

    # The CHECK is written by hand in the migration: every member passes it...
    for status in DispatchStatus:
        await db_session.execute(
            text("UPDATE request_dispatches SET status = :s"), {"s": status.value}
        )
    # ...and anything else fails it.
    with pytest.raises(IntegrityError):
        await db_session.execute(text("UPDATE request_dispatches SET status = 'accepted'"))


async def test_one_row_per_request_and_pro(
    db_session: AsyncSession, ids: tuple[uuid.UUID, uuid.UUID]
) -> None:
    request_id, pro_id = ids
    db_session.add(RequestDispatch(request_id=request_id, pro_id=pro_id, sent_at=NOW))
    await db_session.flush()

    await assert_rejected(
        db_session, RequestDispatch(request_id=request_id, pro_id=pro_id, sent_at=NOW)
    )


async def test_foreign_keys(db_session: AsyncSession, ids: tuple[uuid.UUID, uuid.UUID]) -> None:
    request_id, pro_id = ids

    await assert_rejected(
        db_session, RequestDispatch(request_id=uuid.uuid4(), pro_id=pro_id, sent_at=NOW)
    )
    await assert_rejected(
        db_session, RequestDispatch(request_id=request_id, pro_id=uuid.uuid4(), sent_at=NOW)
    )
    await assert_rejected(db_session, Setting(key="probe", value=1, updated_by=uuid.uuid4()))


async def test_sent_at_and_setting_value_are_required(
    db_session: AsyncSession, ids: tuple[uuid.UUID, uuid.UUID]
) -> None:
    request_id, pro_id = ids
    for statement, params in [
        (
            "INSERT INTO request_dispatches (request_id, pro_id) VALUES (:r, :p)",
            {"r": request_id, "p": pro_id},
        ),
        ("INSERT INTO settings (key) VALUES ('probe')", {}),
    ]:
        savepoint = await db_session.begin_nested()
        with pytest.raises(IntegrityError):
            await db_session.execute(text(statement), params)
        await savepoint.rollback()


async def test_indexes(db_session: AsyncSession) -> None:
    def indexed(connection: Connection) -> dict[str, list[list[str]]]:
        inspector = inspect(connection)
        return {
            table: [
                [str(c) for c in index["column_names"]] for index in inspector.get_indexes(table)
            ]
            for table in ("request_dispatches", "settings")
        }

    connection = await db_session.connection()
    found = await connection.run_sync(indexed)

    assert ["request_id"] in found["request_dispatches"]
    assert ["pro_id"] in found["request_dispatches"]
    assert ["updated_by"] in found["settings"]


async def test_migration_seeds_dispatch_max_pros(db_session: AsyncSession) -> None:
    value = await db_session.scalar(select(Setting.value).where(Setting.key == "dispatch_max_pros"))

    assert value == 5
