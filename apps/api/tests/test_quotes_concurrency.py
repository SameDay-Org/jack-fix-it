"""Two pros' first quotes on one request, at once (#50): real commits on two connections; the
test creates its own rows and deletes them afterwards."""

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime

import pytest
from sqlalchemy import URL, delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.addresses.models import Address
from app.modules.categories.models import Category
from app.modules.dispatch.models import RequestDispatch
from app.modules.pros.models import ProProfile
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.quotes.repository import QuoteRepository
from app.modules.quotes.schemas import QuoteCreate
from app.modules.quotes.service import QuoteService
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.settings.models import Setting
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole
from tests.conftest import backend_pid, wait_until_blocked
from tests.test_quotes_api import TTL_HOURS, body, quotes_of, status_of


@dataclass(frozen=True)
class Committed:
    sessions: async_sessionmaker[AsyncSession]
    request_id: uuid.UUID
    pros: list[tuple[UserAccount, uuid.UUID, uuid.UUID]]  # (account, profile id, dispatch id)


@pytest.fixture
async def committed(test_database_url: URL) -> AsyncIterator[Committed]:
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
        profiles = [ProProfile(user_id=user.id) for user in pro_users]
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
            status=RequestStatus.FINDING_PRO,
        )
        session.add(request)
        await session.flush()
        dispatches = [
            RequestDispatch(request_id=request.id, pro_id=profile.id, sent_at=datetime.now(UTC))
            for profile in profiles
        ]
        session.add_all(dispatches)
        await session.execute(delete(Setting).where(Setting.key == "quote_ttl_hours"))
        session.add(Setting(key="quote_ttl_hours", value=TTL_HOURS))
        await session.commit()
        pros = [
            (
                UserAccount(
                    id=user.id,
                    email=user.email,
                    role=user.role,
                    locale=user.locale,
                    status=user.status,
                ),
                profile.id,
                row.id,
            )
            for user, profile, row in zip(pro_users, profiles, dispatches, strict=True)
        ]
    try:
        yield Committed(sessions, request.id, pros)
    finally:
        async with sessions() as session:
            await session.execute(delete(Quote).where(Quote.request_id == request.id))
            await session.execute(
                delete(RequestDispatch).where(RequestDispatch.request_id == request.id)
            )
            await session.execute(delete(ServiceRequest).where(ServiceRequest.id == request.id))
            await session.execute(delete(Address).where(Address.id == address.id))
            await session.execute(
                delete(ProProfile).where(ProProfile.id.in_([p.id for p in profiles]))
            )
            await session.execute(
                delete(User).where(User.id.in_([customer.id, *[u.id for u in pro_users]]))
            )
            await session.execute(delete(Category).where(Category.id == category.id))
            await session.execute(delete(Setting).where(Setting.key == "quote_ttl_hours"))
            await session.commit()
        await engine.dispose()


async def test_concurrent_first_quotes_from_two_pros_transition_once(
    committed: Committed, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    sessions = committed.sessions
    async with sessions() as first, sessions() as second:
        pids = {id(first): await backend_pid(first), id(second): await backend_pid(second)}
        add = QuoteRepository.add
        holding: list[int] = []

        async def add_then_hold(self: QuoteRepository, row: Quote) -> Quote:
            stored = await add(self, row)
            if not holding:
                # Whichever quote gets the request lock first holds it, with its quote inserted,
                # until Postgres reports the other one waiting on that lock.
                own = pids[id(self._session)]
                holding.append(own)
                [other] = [pid for pid in pids.values() if pid != own]
                await wait_until_blocked(sessions, waiter=other, holder=own)
            return stored

        monkeypatch.setattr(QuoteRepository, "add", add_then_hold)
        data = QuoteCreate.model_validate(body())
        (pro_a, _, dispatch_a), (pro_b, _, dispatch_b) = committed.pros

        with caplog.at_level(logging.INFO):
            results = await asyncio.gather(
                QuoteService(first).submit(pro_a, dispatch_a, data),
                QuoteService(second).submit(pro_b, dispatch_b, data),
            )

    assert [result.status for result in results] == [QuoteStatus.PENDING, QuoteStatus.PENDING]
    async with sessions() as check:
        assert len(await quotes_of(check, committed.request_id)) == 2
        assert await status_of(check, committed.request_id) is RequestStatus.QUOTE_READY
    changes = [
        r
        for r in caplog.records
        if r.message == "request_status_changed"
        and r.__dict__["service_request_id"] == str(committed.request_id)
    ]
    assert [(r.__dict__["from_status"], r.__dict__["to_status"]) for r in changes] == [
        ("finding_pro", "quote_ready")
    ]
