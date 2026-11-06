"""Schema of payments and users.stripe_customer_id (D11.1, #58, ADR 0007), and their
migration."""

import importlib.util
import uuid
from pathlib import Path
from types import ModuleType

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Connection, inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.payments.models import Payment, PaymentStatus
from app.modules.quotes.models import QuoteStatus
from app.modules.requests.models import RequestStatus
from app.modules.users.models import User
from app.modules.users.types import UserRole
from tests.test_opportunities_api import World, build_world, make_request
from tests.test_quote_list_api import add_quote, quoting_pro

MIGRATION = Path(__file__).parents[1] / "alembic" / "versions" / "20261106_a7c3e9d14f62_payments.py"
PAYMENT_CONSTRAINTS = {
    "ck_payments_amount_cents_positive",
    "ck_payments_tax_cents_non_negative",
    "ck_payments_platform_fee_cents_non_negative",
    "ck_payments_pro_payout_cents_non_negative",
    "ck_payments_customer_total_adds_up",
    "ck_payments_split_adds_up",
    "ck_payments_take_rate_bps_range",
    "ck_payments_payment_status",
    "uq_payments_quote_id_live",
    "uq_payments_stripe_payment_intent_id",
}


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("payments_migration", MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    return await build_world(db_session)


async def accepted_quote(session: AsyncSession, world: World) -> tuple[uuid.UUID, uuid.UUID]:
    request_id = await make_request(session, world, RequestStatus.ACCEPTED)
    quote_id = await add_quote(
        session, request_id, await quoting_pro(session), amount=10_005, status=QuoteStatus.ACCEPTED
    )
    return request_id, quote_id


def payment(
    request_id: uuid.UUID, quote_id: uuid.UUID, customer_id: uuid.UUID, **overrides: object
) -> Payment:
    values: dict[str, object] = {
        "request_id": request_id,
        "quote_id": quote_id,
        "customer_id": customer_id,
        "amount_cents": 10_005,
        "tax_cents": 0,
        "customer_total_cents": 10_005,
        "platform_fee_cents": 1_501,
        "pro_payout_cents": 8_504,
        "take_rate_bps": 1_500,
        "currency": "usd",
    }
    values.update(overrides)
    return Payment(**values)


async def assert_rejected(session: AsyncSession, row: object, constraint: str) -> None:
    savepoint = await session.begin_nested()
    session.add(row)
    with pytest.raises(IntegrityError, match=constraint):
        await session.flush()
    await savepoint.rollback()


async def test_defaults(db_session: AsyncSession, world: World) -> None:
    request_id, quote_id = await accepted_quote(db_session, world)
    row = payment(request_id, quote_id, world.customer_id)
    db_session.add(row)
    await db_session.flush()
    await db_session.refresh(row)

    assert row.status is PaymentStatus.REQUIRES_PAYMENT
    assert row.stripe_payment_intent_id is None
    assert row.created_at is not None


@pytest.mark.parametrize(
    ("overrides", "constraint"),
    [
        (
            {
                "amount_cents": 0,
                "customer_total_cents": 0,
                "platform_fee_cents": 0,
                "pro_payout_cents": 0,
            },
            "ck_payments_amount_cents_positive",
        ),
        ({"tax_cents": -1, "customer_total_cents": 10_004}, "ck_payments_tax_cents_non_negative"),
        (
            {"platform_fee_cents": -1, "pro_payout_cents": 10_006},
            "ck_payments_platform_fee_cents_non_negative",
        ),
        (
            {"pro_payout_cents": -1, "platform_fee_cents": 10_006},
            "ck_payments_pro_payout_cents_non_negative",
        ),
        ({"customer_total_cents": 10_006}, "ck_payments_customer_total_adds_up"),
        ({"tax_cents": 100}, "ck_payments_customer_total_adds_up"),
        ({"pro_payout_cents": 8_505}, "ck_payments_split_adds_up"),
        ({"take_rate_bps": 10_001}, "ck_payments_take_rate_bps_range"),
        ({"take_rate_bps": -1}, "ck_payments_take_rate_bps_range"),
    ],
)
async def test_amounts_are_held_to_their_sums(
    db_session: AsyncSession, world: World, overrides: dict[str, object], constraint: str
) -> None:
    request_id, quote_id = await accepted_quote(db_session, world)

    await assert_rejected(
        db_session, payment(request_id, quote_id, world.customer_id, **overrides), constraint
    )


@pytest.mark.parametrize(
    "live", [s for s in PaymentStatus if s is not PaymentStatus.CANCELED], ids=str
)
async def test_one_live_payment_per_quote(
    db_session: AsyncSession, world: World, live: PaymentStatus
) -> None:
    """Two live payments for one quote are impossible whatever the service does (#58 B4):
    the partial unique index refuses a second one beside any status but canceled."""
    request_id, quote_id = await accepted_quote(db_session, world)
    db_session.add(payment(request_id, quote_id, world.customer_id, status=live))
    await db_session.flush()

    await assert_rejected(
        db_session, payment(request_id, quote_id, world.customer_id), "uq_payments_quote_id_live"
    )


async def test_canceled_payments_stay_beside_the_live_one(
    db_session: AsyncSession, world: World
) -> None:
    """A quote accepted again after cancels keeps every canceled payment and one live one."""
    request_id, quote_id = await accepted_quote(db_session, world)
    canceled = PaymentStatus.CANCELED
    db_session.add_all(
        [
            payment(request_id, quote_id, world.customer_id, status=canceled),
            payment(request_id, quote_id, world.customer_id, status=canceled),
            payment(request_id, quote_id, world.customer_id),
        ]
    )
    await db_session.flush()

    await assert_rejected(
        db_session, payment(request_id, quote_id, world.customer_id), "uq_payments_quote_id_live"
    )


async def test_payment_intent_id_is_unique(db_session: AsyncSession, world: World) -> None:
    first_request, first_quote = await accepted_quote(db_session, world)
    second_request, second_quote = await accepted_quote(db_session, world)
    intent_id = f"pi_schema_{uuid.uuid4().hex[:8]}"
    db_session.add(
        payment(first_request, first_quote, world.customer_id, stripe_payment_intent_id=intent_id)
    )
    await db_session.flush()

    await assert_rejected(
        db_session,
        payment(
            second_request, second_quote, world.customer_id, stripe_payment_intent_id=intent_id
        ),
        "uq_payments_stripe_payment_intent_id",
    )


async def test_stripe_customer_id_is_unique_and_optional(db_session: AsyncSession) -> None:
    customer_id = f"cus_schema_{uuid.uuid4().hex[:8]}"
    rows = [
        User(email=f"u-{n}-{uuid.uuid4().hex[:6]}@x.com", password_hash="x", role=UserRole.CUSTOMER)
        for n in range(3)
    ]
    rows[0].stripe_customer_id = customer_id
    db_session.add_all(rows)
    await db_session.flush()
    assert (rows[1].stripe_customer_id, rows[2].stripe_customer_id) == (None, None)

    rows[1].stripe_customer_id = customer_id
    with pytest.raises(IntegrityError, match="uq_users_stripe_customer_id"):
        await db_session.flush()


def table_names(connection: Connection) -> set[str]:
    return set(inspect(connection).get_table_names())


def payment_constraint_names(connection: Connection) -> set[str]:
    inspector = inspect(connection)
    names = {str(c["name"]) for c in inspector.get_check_constraints("payments")}
    names |= {str(c["name"]) for c in inspector.get_unique_constraints("payments")}
    names |= {str(i["name"]) for i in inspector.get_indexes("payments") if i["unique"]}
    return names


def user_columns(connection: Connection) -> set[str]:
    return {column["name"] for column in inspect(connection).get_columns("users")}


async def test_downgrade_drops_the_table_and_column_and_upgrade_restores_them(
    db_session: AsyncSession,
) -> None:
    # Run on the test session's transaction, which is rolled back: Postgres DDL is
    # transactional, so the shared test database keeps its head.
    module = migration()

    def after(step: str, connection: Connection) -> tuple[set[str], set[str]]:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, step)()
        return table_names(connection), user_columns(connection)

    connection = await db_session.connection()
    assert await connection.run_sync(lambda c: payment_constraint_names(c)) >= PAYMENT_CONSTRAINTS
    tables, columns = await connection.run_sync(lambda c: after("downgrade", c))
    assert "payments" not in tables
    assert "stripe_customer_id" not in columns
    tables, columns = await connection.run_sync(lambda c: after("upgrade", c))
    assert "payments" in tables
    assert "stripe_customer_id" in columns
    assert await connection.run_sync(lambda c: payment_constraint_names(c)) >= PAYMENT_CONSTRAINTS
