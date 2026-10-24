"""Two acceptances on one request, at once (#189): real commits on two connections; the test
creates its own rows and deletes them afterwards."""

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import URL, delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.addresses.models import Address
from app.modules.categories.models import Category
from app.modules.pros.models import ProProfile, ProVerificationStatus
from app.modules.quotes.errors import QuoteNotAcceptableError
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.quotes.repository import QuoteRepository
from app.modules.quotes.schemas import CustomerQuote
from app.modules.quotes.service import QuoteService
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole
from tests.conftest import backend_pid, wait_until_blocked
from tests.helpers import as_status_writer
from tests.test_quotes_api import quotes_of, status_of


@dataclass(frozen=True)
class Committed:
    sessions: async_sessionmaker[AsyncSession]
    customer: UserAccount
    request_id: uuid.UUID
    quote_ids: list[uuid.UUID]


@pytest.fixture
async def committed(test_database_url: URL) -> AsyncIterator[Committed]:
    """A quote_ready request with two pending quotes from two hireable pros."""
    engine = create_async_engine(test_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    tag = uuid.uuid4().hex[:8]
    async with sessions() as session:
        customer = User(email=f"c-{tag}@x.com", password_hash="x", role=UserRole.CUSTOMER)
        pro_users = [
            User(email=f"p{n}-{tag}@x.com", password_hash="x", role=UserRole.PRO) for n in range(2)
        ]
        category = Category(slug=f"test-{tag}", names={"en": "Test", "es": "Prueba"})
        session.add_all([customer, *pro_users, category])
        await session.flush()
        profiles = [
            ProProfile(
                user_id=user.id,
                verification_status=ProVerificationStatus.APPROVED,
                payouts_enabled=True,
            )
            for user in pro_users
        ]
        address = Address(
            user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
        )
        session.add_all([*profiles, address])
        await session.flush()
        request = ServiceRequest(
            customer_id=customer.id,
            address_id=address.id,
            category_id=category.id,
            description="Fix a leak",
            origin=RequestOrigin.APP,
            status=RequestStatus.QUOTE_READY,
        )
        async with as_status_writer(session):  # the database guard (#163)
            session.add(request)
            await session.flush()
        quotes = [
            Quote(
                request_id=request.id,
                pro_id=profile.id,
                amount_cents=10_000 + n,
                scope="Replace the valve",
                duration_minutes=60,
                proposed_start_at=datetime.now(UTC) + timedelta(days=2),
                expires_at=datetime.now(UTC) + timedelta(hours=24),
            )
            for n, profile in enumerate(profiles)
        ]
        session.add_all(quotes)
        await session.commit()
        account = UserAccount(
            id=customer.id,
            email=customer.email,
            role=customer.role,
            locale=customer.locale,
            status=customer.status,
        )
    try:
        yield Committed(sessions, account, request.id, [quote.id for quote in quotes])
    finally:
        async with sessions() as session:
            await session.execute(delete(Quote).where(Quote.request_id == request.id))
            await session.execute(delete(ServiceRequest).where(ServiceRequest.id == request.id))
            await session.execute(delete(Address).where(Address.id == address.id))
            await session.execute(
                delete(ProProfile).where(ProProfile.id.in_([p.id for p in profiles]))
            )
            await session.execute(
                delete(User).where(User.id.in_([customer.id, *[u.id for u in pro_users]]))
            )
            await session.execute(delete(Category).where(Category.id == category.id))
            await session.commit()
        await engine.dispose()


async def accept_at_once(
    committed: Committed, monkeypatch: pytest.MonkeyPatch, first_quote: uuid.UUID, second: uuid.UUID
) -> tuple[CustomerQuote | BaseException, CustomerQuote | BaseException]:
    """Both acceptances run at once. Whichever reaches the quote's write first holds it there,
    with its request and quote locked, until Postgres reports the other one waiting on a lock it
    holds; then it goes on and commits."""
    sessions = committed.sessions
    async with sessions() as one, sessions() as two:
        pids = {id(one): await backend_pid(one), id(two): await backend_pid(two)}
        mark_accepted = QuoteRepository.mark_accepted
        holding: list[int] = []

        async def mark_then_hold(self: QuoteRepository, quote: Quote) -> None:
            await mark_accepted(self, quote)
            if not holding:
                own = pids[id(self._session)]
                holding.append(own)
                [other] = [pid for pid in pids.values() if pid != own]
                await wait_until_blocked(sessions, waiter=other, holder=own)

        monkeypatch.setattr(QuoteRepository, "mark_accepted", mark_then_hold)
        return await asyncio.gather(
            QuoteService(one).accept(committed.customer, committed.request_id, first_quote),
            QuoteService(two).accept(committed.customer, committed.request_id, second),
            return_exceptions=True,
        )


def events(caplog: pytest.LogCaptureFixture, message: str, request_id: uuid.UUID) -> int:
    return sum(
        1
        for record in caplog.records
        if record.message == message and record.__dict__["service_request_id"] == str(request_id)
    )


async def test_concurrent_accepts_of_different_quotes_one_wins(
    committed: Committed, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    first, second = committed.quote_ids

    with caplog.at_level(logging.INFO):
        results = await accept_at_once(committed, monkeypatch, first, second)

    won = [result for result in results if isinstance(result, CustomerQuote)]
    lost = [result for result in results if isinstance(result, BaseException)]
    assert len(won) == 1, results
    assert len(lost) == 1
    assert isinstance(lost[0], QuoteNotAcceptableError), lost[0]
    async with committed.sessions() as check:
        assert await status_of(check, committed.request_id) is RequestStatus.ACCEPTED
        stored = {q.id: q.status for q in await quotes_of(check, committed.request_id)}
    assert stored[won[0].id] is QuoteStatus.ACCEPTED
    assert sorted(stored.values()) == [QuoteStatus.ACCEPTED, QuoteStatus.PENDING]
    assert events(caplog, "quote_accepted", committed.request_id) == 1
    assert events(caplog, "request_status_changed", committed.request_id) == 1


async def test_concurrent_accepts_of_the_same_quote_are_one_change(
    committed: Committed, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    chosen, other = committed.quote_ids

    with caplog.at_level(logging.INFO):
        results = await accept_at_once(committed, monkeypatch, chosen, chosen)

    assert all(isinstance(result, CustomerQuote) for result in results), results
    first, second = results
    assert first == second
    async with committed.sessions() as check:
        assert await status_of(check, committed.request_id) is RequestStatus.ACCEPTED
        stored = {q.id: q.status for q in await quotes_of(check, committed.request_id)}
    assert stored == {chosen: QuoteStatus.ACCEPTED, other: QuoteStatus.PENDING}
    assert events(caplog, "quote_accepted", committed.request_id) == 1
    assert events(caplog, "request_status_changed", committed.request_id) == 1
