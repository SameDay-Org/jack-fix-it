"""Schema of service_requests, quotes, jobs and job_events (D4.1 part 2, #108, ADR 0007)."""

import re
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from enum import StrEnum

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import Connection, UniqueConstraint, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import Base, import_models
from app.modules.addresses.models import Address
from app.modules.categories.models import Category
from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.pros.models import ProProfile
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.requests.models import (
    PUBLIC_CODE_SEQUENCE,
    RequestOrigin,
    RequestStatus,
    ServiceRequest,
)
from app.modules.users.models import User, UserRole
from tests.test_schema_core import assert_rejected

import_models()

NEW_TABLES = {"service_requests", "quotes", "jobs", "job_events"}
NOW = datetime(2026, 10, 21, 12, 0, tzinfo=UTC)


@dataclass(frozen=True)
class World:
    customer: User
    agent: User
    pro_user: User
    pro: ProProfile
    other_pro: ProProfile
    category: Category
    address: Address


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    customer = User(email="customer@x.com", password_hash="x", role=UserRole.CUSTOMER)
    agent = User(email="agent@x.com", password_hash="x", role=UserRole.AGENT)
    pro_user = User(email="pro@x.com", password_hash="x", role=UserRole.PRO)
    other_pro_user = User(email="pro2@x.com", password_hash="x", role=UserRole.PRO)
    db_session.add_all([customer, agent, pro_user, other_pro_user])
    await db_session.flush()
    pro = ProProfile(user_id=pro_user.id)
    other_pro = ProProfile(user_id=other_pro_user.id)
    category = Category(slug="test-category", names={"en": "Test", "es": "Prueba"})
    address = Address(
        user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
    )
    db_session.add_all([pro, other_pro, category, address])
    await db_session.flush()
    return World(customer, agent, pro_user, pro, other_pro, category, address)


def make_request(world: World, **overrides: object) -> ServiceRequest:
    values: dict[str, object] = {
        "customer_id": world.customer.id,
        "category_id": world.category.id,
        "address_id": world.address.id,
        "description": "Paint one bedroom",
        "origin": RequestOrigin.APP,
    }
    values.update(overrides)
    return ServiceRequest(**values)


def make_quote(request: ServiceRequest, pro: ProProfile, **overrides: object) -> Quote:
    values: dict[str, object] = {
        "request_id": request.id,
        "pro_id": pro.id,
        "amount_cents": 25_000,
        "scope": "Walls and ceiling",
        "duration_minutes": 240,
        "proposed_start_at": NOW + timedelta(days=2),
        "expires_at": NOW + timedelta(days=1),
    }
    values.update(overrides)
    return Quote(**values)


def make_job(request: ServiceRequest, quote: Quote, world: World, **overrides: object) -> Job:
    values: dict[str, object] = {
        "request_id": request.id,
        "quote_id": quote.id,
        "customer_id": world.customer.id,
        "pro_id": world.pro.id,
        "customer_price_cents": 25_000,
        "pro_payout_cents": 21_250,
        "platform_fee_cents": 3_750,
        "tax_cents": 0,
    }
    values.update(overrides)
    return Job(**values)


async def add(session: AsyncSession, *rows: object) -> None:
    session.add_all(rows)
    await session.flush()


async def make_job_graph(session: AsyncSession, world: World) -> tuple[ServiceRequest, Quote, Job]:
    request = make_request(world)
    await add(session, request)
    quote = make_quote(request, world.pro)
    await add(session, quote)
    job = make_job(request, quote, world)
    await add(session, job)
    return request, quote, job


@pytest.fixture
async def restore_code_sequence(db_session: AsyncSession) -> AsyncIterator[None]:
    """setval is not transactional: put the sequence back as it was, for the next tests."""
    query = f"SELECT last_value, is_called FROM {PUBLIC_CODE_SEQUENCE}"  # noqa: S608 - a constant
    state = (await db_session.execute(text(query))).one()
    yield
    await db_session.execute(
        text("SELECT setval(CAST(:name AS regclass), :value, :called)"),
        {"name": PUBLIC_CODE_SEQUENCE, "value": state.last_value, "called": state.is_called},
    )


async def set_next_code_number(session: AsyncSession, number: int) -> None:
    await session.execute(
        text("SELECT setval(CAST(:name AS regclass), :value, false)"),
        {"name": PUBLIC_CODE_SEQUENCE, "value": number},
    )


# Migration


async def test_migration_matches_models(db_session: AsyncSession) -> None:
    def diff_and_tables(connection: Connection) -> tuple[list[object], set[str]]:
        diff = list(compare_metadata(MigrationContext.configure(connection), Base.metadata))
        return diff, set(inspect(connection).get_table_names())

    connection = await db_session.connection()
    diff, tables = await connection.run_sync(diff_and_tables)

    assert diff == []
    assert tables >= NEW_TABLES
    assert set(Base.metadata.tables) >= NEW_TABLES


# service_requests


async def test_service_request_defaults(db_session: AsyncSession, world: World) -> None:
    request = make_request(world, category_id=None)
    await add(db_session, request)
    await db_session.refresh(request)

    assert request.status is RequestStatus.RECEIVED
    assert request.language == "en"
    assert request.intake_answers == {}
    assert request.utm is None
    assert request.assigned_agent_id is None


async def test_public_code_format_and_uniqueness(
    db_session: AsyncSession, world: World, restore_code_sequence: None
) -> None:
    await set_next_code_number(db_session, 1)
    first, second = make_request(world), make_request(world)
    await add(db_session, first)
    await add(db_session, second)

    assert (first.public_code, second.public_code) == ("JF-000001", "JF-000002")
    # Unique even if a code were set by hand.
    await assert_rejected(db_session, make_request(world, public_code=first.public_code))


@pytest.mark.parametrize(
    ("next_number", "expected"),
    [(999_999, "JF-999999"), (1_000_000, "JF-1000000"), (1_234_567, "JF-1234567")],
)
async def test_public_code_never_truncates(
    db_session: AsyncSession,
    world: World,
    restore_code_sequence: None,
    next_number: int,
    expected: str,
) -> None:
    # lpad(n, 6) would give 100000 and 123456 here.
    await set_next_code_number(db_session, next_number)
    request = make_request(world)
    await add(db_session, request)

    assert request.public_code == expected
    assert re.fullmatch(r"JF-\d{6,}", request.public_code)


# Enum CHECKs


ENUM_COLUMNS: list[tuple[str, str, type[StrEnum]]] = [
    ("service_requests", "status", RequestStatus),
    ("service_requests", "origin", RequestOrigin),
    ("quotes", "status", QuoteStatus),
    ("jobs", "status", JobStatus),
    ("job_events", "from_status", JobStatus),
    ("job_events", "to_status", JobStatus),
]
ENUM_IDS = [f"{table}.{column}" for table, column, _ in ENUM_COLUMNS]


async def row_ids(session: AsyncSession, world: World) -> dict[str, uuid.UUID]:
    request, quote, job = await make_job_graph(session, world)
    event = JobEvent(job_id=job.id, type="status_changed")
    await add(session, event)
    return {
        "service_requests": request.id,
        "quotes": quote.id,
        "jobs": job.id,
        "job_events": event.id,
    }


@pytest.mark.parametrize(("table", "column", "enum"), ENUM_COLUMNS, ids=ENUM_IDS)
async def test_status_checks_reject_unknown_values(
    db_session: AsyncSession, world: World, table: str, column: str, enum: type[StrEnum]
) -> None:
    ids = await row_ids(db_session, world)

    with pytest.raises(IntegrityError):
        await db_session.execute(
            # Table and column names come from ENUM_COLUMNS, never from input.
            text(f"UPDATE {table} SET {column} = 'not_a_state' WHERE id = :id"),  # noqa: S608
            {"id": ids[table]},
        )


@pytest.mark.parametrize(("table", "column", "enum"), ENUM_COLUMNS, ids=ENUM_IDS)
async def test_status_checks_accept_every_value(
    db_session: AsyncSession, world: World, table: str, column: str, enum: type[StrEnum]
) -> None:
    # The migration's CHECKs are written by hand; every StrEnum member must pass them.
    ids = await row_ids(db_session, world)

    for member in enum:
        await db_session.execute(
            text(f"UPDATE {table} SET {column} = :value WHERE id = :id"),  # noqa: S608
            {"value": member.value, "id": ids[table]},
        )


# quotes and jobs


async def test_quote_defaults(db_session: AsyncSession, world: World) -> None:
    request = make_request(world)
    await add(db_session, request)
    quote = make_quote(request, world.pro)
    await add(db_session, quote)
    await db_session.refresh(quote)

    assert quote.status is QuoteStatus.PENDING


async def test_quote_unique_per_pro_and_request(db_session: AsyncSession, world: World) -> None:
    request, other_request = make_request(world), make_request(world)
    await add(db_session, request, other_request)
    await add(db_session, make_quote(request, world.pro))

    await assert_rejected(db_session, make_quote(request, world.pro))
    # Another pro on the same request, or the same pro on another request, is fine.
    await add(db_session, make_quote(request, world.other_pro))
    await add(db_session, make_quote(other_request, world.pro))


async def test_money_columns_non_negative(db_session: AsyncSession, world: World) -> None:
    request = make_request(world)
    await add(db_session, request)
    for amount in (0, -1):
        await assert_rejected(db_session, make_quote(request, world.pro, amount_cents=amount))
    await assert_rejected(db_session, make_quote(request, world.pro, duration_minutes=0))
    quote = make_quote(request, world.pro)
    await add(db_session, quote)

    for column in ("customer_price_cents", "pro_payout_cents", "platform_fee_cents", "tax_cents"):
        await assert_rejected(db_session, make_job(request, quote, world, **{column: -1}))
    # Zero is allowed everywhere, and nothing ties the four amounts together (#2).
    job = make_job(
        request,
        quote,
        world,
        customer_price_cents=0,
        pro_payout_cents=0,
        platform_fee_cents=0,
        tax_cents=0,
    )
    await add(db_session, job)
    await db_session.refresh(job)
    assert job.status is JobStatus.SCHEDULED


async def test_job_unique_per_request_and_quote(db_session: AsyncSession, world: World) -> None:
    request, quote, _ = await make_job_graph(db_session, world)
    other_request = make_request(world)
    await add(db_session, other_request)
    other_quote = make_quote(request, world.other_pro)
    await add(db_session, other_quote)

    # A second job for the same request, through another quote.
    await assert_rejected(db_session, make_job(request, other_quote, world))
    # A second job for the same quote, on another request.
    await assert_rejected(db_session, make_job(other_request, quote, world))


async def test_job_event_actor_nullable_for_system_events(
    db_session: AsyncSession, world: World
) -> None:
    _, _, job = await make_job_graph(db_session, world)
    system = JobEvent(
        job_id=job.id,
        type="status_changed",
        from_status=JobStatus.COMPLETED,
        to_status=JobStatus.CONFIRMED,
    )
    by_pro = JobEvent(
        job_id=job.id,
        type="check_in",
        actor_id=world.pro_user.id,
        lat=Decimal("28.538336"),
        lng=Decimal("-81.379234"),
    )
    await add(db_session, system, by_pro)
    await db_session.refresh(system)
    await db_session.refresh(by_pro)

    assert system.actor_id is None
    assert (system.from_status, system.to_status) == (JobStatus.COMPLETED, JobStatus.CONFIRMED)
    assert by_pro.from_status is None
    assert by_pro.to_status is None
    assert (by_pro.lat, by_pro.lng) == (Decimal("28.538336"), Decimal("-81.379234"))


# Foreign keys


# SQLSTATE of foreign_key_violation.
FOREIGN_KEY_VIOLATION = "23503"
FOREIGN_KEYS = [
    ("service_requests", "customer_id"),
    ("service_requests", "category_id"),
    ("service_requests", "address_id"),
    ("service_requests", "assigned_agent_id"),
    ("quotes", "request_id"),
    ("quotes", "pro_id"),
    ("jobs", "request_id"),
    ("jobs", "quote_id"),
    ("jobs", "customer_id"),
    ("jobs", "pro_id"),
    ("job_events", "job_id"),
    ("job_events", "actor_id"),
]


@pytest.mark.parametrize(
    ("table", "column"), FOREIGN_KEYS, ids=[f"{t}.{c}" for t, c in FOREIGN_KEYS]
)
async def test_fk_targets_must_exist(
    db_session: AsyncSession, world: World, table: str, column: str
) -> None:
    request, _, job = await make_job_graph(db_session, world)
    # The jobs candidate needs its own request and quote: valid in every other column, so
    # only the foreign key under test can fail.
    free_request = make_request(world)
    await add(db_session, free_request)
    free_quote = make_quote(free_request, world.other_pro)
    await add(db_session, free_quote)
    candidates: dict[str, object] = {
        "service_requests": make_request(world),
        "quotes": make_quote(request, world.other_pro),
        "jobs": make_job(free_request, free_quote, world),
        "job_events": JobEvent(job_id=job.id, type="note", actor_id=world.agent.id),
    }
    row = candidates[table]
    setattr(row, column, uuid.uuid4())

    savepoint = await db_session.begin_nested()
    db_session.add(row)
    with pytest.raises(IntegrityError) as error:
        await db_session.flush()
    await savepoint.rollback()
    # The foreign key itself, not another constraint, rejected the row.
    cause = error.value.orig.__cause__ if error.value.orig else None
    assert getattr(cause, "sqlstate", None) == FOREIGN_KEY_VIOLATION


def test_every_foreign_key_is_indexed() -> None:
    # ADR 0007: a btree index on every foreign key column; a UNIQUE or composite index led by
    # the column counts.
    for table_name in NEW_TABLES:
        table = Base.metadata.tables[table_name]
        leading = {index.columns[0].name for index in table.indexes}
        leading |= {
            constraint.columns[0].name
            for constraint in table.constraints
            if isinstance(constraint, UniqueConstraint)
        }
        leading |= {column.name for column in table.columns if column.unique}
        for fk in table.foreign_keys:
            assert fk.parent.name in leading, f"{table_name}.{fk.parent.name} has no index"
