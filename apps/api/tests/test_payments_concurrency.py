"""Two payment calls for one accepted quote, at once (#58): real commits on two connections; the
test creates its own rows and deletes them afterwards."""

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import URL, delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.addresses.models import Address
from app.modules.categories.models import Category
from app.modules.payments.models import Payment
from app.modules.payments.schemas import PaymentSheetOut
from app.modules.payments.service import PaymentService
from app.modules.pros.models import ProProfile, ProVerificationStatus
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole
from tests.conftest import LOCK_WAIT_DEADLINE_SECONDS, backend_pid
from tests.helpers import as_status_writer
from tests.test_payments_api import PUBLISHABLE_KEY, FakeStripePayments


@dataclass(frozen=True)
class Committed:
    sessions: async_sessionmaker[AsyncSession]
    customer: UserAccount
    request_id: uuid.UUID
    quote_id: uuid.UUID


@pytest.fixture
async def committed(test_database_url: URL) -> AsyncIterator[Committed]:
    """An accepted request with its accepted quote from a hireable pro; the take rate is the
    default (no settings row is written)."""
    engine = create_async_engine(test_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    tag = uuid.uuid4().hex[:8]
    async with sessions() as session:
        customer = User(email=f"c-{tag}@x.com", password_hash="x", role=UserRole.CUSTOMER)
        pro_user = User(email=f"p-{tag}@x.com", password_hash="x", role=UserRole.PRO)
        category = Category(slug=f"test-{tag}", names={"en": "Test", "es": "Prueba"})
        session.add_all([customer, pro_user, category])
        await session.flush()
        profile = ProProfile(
            user_id=pro_user.id,
            verification_status=ProVerificationStatus.APPROVED,
            payouts_enabled=True,
        )
        address = Address(
            user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
        )
        session.add_all([profile, address])
        await session.flush()
        request = ServiceRequest(
            customer_id=customer.id,
            address_id=address.id,
            category_id=category.id,
            description="Fix a leak",
            origin=RequestOrigin.APP,
            status=RequestStatus.ACCEPTED,
        )
        async with as_status_writer(session):  # the database guard (#163)
            session.add(request)
            await session.flush()
        quote = Quote(
            request_id=request.id,
            pro_id=profile.id,
            amount_cents=10_005,
            scope="Replace the valve",
            duration_minutes=60,
            proposed_start_at=datetime.now(UTC) + timedelta(days=2),
            expires_at=datetime.now(UTC) + timedelta(hours=24),
            status=QuoteStatus.ACCEPTED,
        )
        session.add(quote)
        await session.commit()
        account = UserAccount(
            id=customer.id,
            email=customer.email,
            role=customer.role,
            locale=customer.locale,
            status=customer.status,
            public_code=customer.public_code,
            created_at=customer.created_at,
        )
    try:
        yield Committed(sessions, account, request.id, quote.id)
    finally:
        async with sessions() as session:
            await session.execute(delete(Payment).where(Payment.request_id == request.id))
            await session.execute(delete(Quote).where(Quote.request_id == request.id))
            await session.execute(delete(ServiceRequest).where(ServiceRequest.id == request.id))
            await session.execute(delete(Address).where(Address.id == address.id))
            await session.execute(delete(ProProfile).where(ProProfile.id == profile.id))
            await session.execute(delete(User).where(User.id.in_([customer.id, pro_user.id])))
            await session.execute(delete(Category).where(Category.id == category.id))
            await session.commit()
        await engine.dispose()


async def _wait_until_one_blocks(
    sessions: async_sessionmaker[AsyncSession], pids: list[int]
) -> None:
    """Returns once Postgres reports either backend waiting on a lock the other holds."""
    first, second = pids
    query = text(
        "SELECT CAST(:second AS integer) = ANY(pg_blocking_pids(:first)) "
        "OR CAST(:first AS integer) = ANY(pg_blocking_pids(:second))"
    )
    async with sessions() as monitor:
        try:
            async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
                while not await monitor.scalar(query, {"first": first, "second": second}):
                    pass
        except TimeoutError:
            pytest.fail(f"neither call waited on the other within {LOCK_WAIT_DEADLINE_SECONDS} s")


def events(caplog: pytest.LogCaptureFixture, message: str, request_id: uuid.UUID) -> int:
    return sum(
        1
        for record in caplog.records
        if record.message == message and record.__dict__["service_request_id"] == str(request_id)
    )


async def test_concurrent_payments_create_one_intent(
    committed: Committed, caplog: pytest.LogCaptureFixture
) -> None:
    """Both calls start with no payment row. The request's lock serializes the row's creation;
    whichever call creates the PaymentIntent holds the row locked there until Postgres reports
    the other waiting on that lock, then stores the id and commits; the other finds the id and
    reads the intent back. One row, one PaymentIntent, one customer."""
    sessions = committed.sessions
    stripe = FakeStripePayments()
    with caplog.at_level(logging.INFO):
        async with sessions() as one, sessions() as two:
            pids = [await backend_pid(one), await backend_pid(two)]

            async def hold_until_the_other_waits() -> None:
                await _wait_until_one_blocks(sessions, pids)

            stripe.on_create_intent = hold_until_the_other_waits
            try:
                async with asyncio.timeout(2 * LOCK_WAIT_DEADLINE_SECONDS):
                    results = await asyncio.gather(
                        *(
                            PaymentService(session, stripe, PUBLISHABLE_KEY).payment_sheet(
                                committed.customer, committed.request_id, committed.quote_id
                            )
                            for session in (one, two)
                        ),
                        return_exceptions=True,
                    )
            except TimeoutError:
                pytest.fail("a payment call never finished: the other kept the locks (no commit?)")

    assert [type(result).__name__ for result in results] == ["PaymentSheetOut"] * 2, results
    first, second = results
    assert isinstance(first, PaymentSheetOut)
    assert isinstance(second, PaymentSheetOut)
    assert first.payment_intent_client_secret == second.payment_intent_client_secret
    assert first.customer_id == second.customer_id
    assert first.ephemeral_key_secret != second.ephemeral_key_secret
    assert len(stripe.intent_calls) == 1
    [intent_id] = stripe.intents
    assert stripe.retrieved == [intent_id]
    assert len(stripe.customers) == 1
    async with sessions() as check:
        rows = list(
            (
                await check.scalars(select(Payment).where(Payment.quote_id == committed.quote_id))
            ).all()
        )
        stored_customer = await check.scalar(
            select(User.stripe_customer_id).where(User.id == committed.customer.id)
        )
    [payment] = rows
    assert payment.stripe_payment_intent_id == intent_id
    assert stored_customer == first.customer_id
    assert events(caplog, "payment_created", committed.request_id) == 1
    assert events(caplog, "payment_intent_created", committed.request_id) == 1
    assert events(caplog, "payment_sheet_issued", committed.request_id) == 2


async def test_payment_row_is_committed_before_stripe_is_called(committed: Committed) -> None:
    """When the first Stripe call (the customer create) runs, another connection already sees
    the payment row, and the request's and quote's locks are released: a lost answer leaves
    the row (and its key), and no lock is held over a network call."""
    sessions = committed.sessions
    stripe = FakeStripePayments()
    seen: list[tuple[int, bool]] = []

    async def look_from_another_connection() -> None:
        async with sessions() as other:
            rows = (
                await other.scalars(select(Payment).where(Payment.quote_id == committed.quote_id))
            ).all()
            # NOWAIT: a lock still held raises at once instead of waiting.
            locked = (
                await other.execute(
                    text(
                        "SELECT r.id FROM service_requests r JOIN quotes q ON q.request_id = r.id "
                        "WHERE r.id = :request_id AND q.id = :quote_id FOR UPDATE NOWAIT"
                    ),
                    {"request_id": committed.request_id, "quote_id": committed.quote_id},
                )
            ).all()
            await other.rollback()
        seen.append((len(rows), len(locked) == 1))

    stripe.on_create_customer = look_from_another_connection
    async with sessions() as session:
        sheet = await PaymentService(session, stripe, PUBLISHABLE_KEY).payment_sheet(
            committed.customer, committed.request_id, committed.quote_id
        )

    assert isinstance(sheet, PaymentSheetOut)
    assert seen == [(1, True)]
