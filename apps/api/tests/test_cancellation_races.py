"""Two cancels of one job at once (#69): the second waits on the job's lock, then returns the
first cancellation. Real commits on separate connections; the audit write is recorded instead
of written (audit_log is append-only: a committed row could never be deleted; the rows
themselves are proven on the rolled-back session in test_cancellations_api.py). The test
deletes its own rows afterwards."""

import asyncio
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import URL, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.addresses.models import Address
from app.modules.audit.service import AuditService
from app.modules.cancellations.models import CancelParty, JobCancellation
from app.modules.cancellations.repository import CancellationRepository
from app.modules.cancellations.schemas import (
    CustomerCancelIn,
    CustomerCancelReason,
    ProCancelIn,
    ProCancelReason,
)
from app.modules.cancellations.service import CancelConfig, CancellationService
from app.modules.jobs.location import NoJobLocationStore
from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.payments.models import Payment, PaymentStatus, Refund
from app.modules.pros.models import ProProfile
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole
from tests.helpers import as_status_writer
from tests.test_disputes_api import RecordingQueue
from tests.test_job_state_concurrency import backend_pid, wait_until_blocked

NOW = datetime(2030, 3, 1, 12, 0, tzinfo=UTC)
PRICE, TAX, PAYOUT, FEE = 20_000, 1_400, 17_000, 3_000


@dataclass(frozen=True)
class CommittedBooking:
    sessions: async_sessionmaker[AsyncSession]
    job_id: uuid.UUID
    customer: UserAccount
    audited: list[tuple[uuid.UUID, str]]
    pro: UserAccount


@pytest.fixture
async def booking(
    test_database_url: URL, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[CommittedBooking]:
    """A scheduled, paid job with its customer, pro, address, accepted request and quote, all
    committed; its audit writes recorded, not written."""
    audited: list[tuple[uuid.UUID, str]] = []

    async def record(self: AuditService, actor_id: uuid.UUID, action: Any, *args: Any) -> None:
        audited.append((actor_id, action.value))

    monkeypatch.setattr(AuditService, "record_party_action", record)
    engine = create_async_engine(test_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    tag = uuid.uuid4().hex[:12]
    async with sessions() as session:
        customer = User(email=f"c69-{tag}@x.com", password_hash="x", role=UserRole.CUSTOMER)
        pro_user = User(email=f"p69-{tag}@x.com", password_hash="x", role=UserRole.PRO)
        session.add_all([customer, pro_user])
        await session.flush()
        profile = ProProfile(user_id=pro_user.id)
        address = Address(
            user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
        )
        session.add_all([profile, address])
        await session.flush()
        request = ServiceRequest(
            customer_id=customer.id,
            address_id=address.id,
            description="Fix the faucet",
            origin=RequestOrigin.APP,
            status=RequestStatus.ACCEPTED,
        )
        async with as_status_writer(session):
            session.add(request)
            await session.flush()
        quote = Quote(
            request_id=request.id,
            pro_id=profile.id,
            amount_cents=PRICE,
            scope="Faucet",
            duration_minutes=60,
            proposed_start_at=NOW + timedelta(days=1),
            expires_at=NOW,
            status=QuoteStatus.ACCEPTED,
        )
        session.add(quote)
        await session.flush()
        job = Job(
            request_id=request.id,
            quote_id=quote.id,
            customer_id=customer.id,
            pro_id=profile.id,
            status=JobStatus.SCHEDULED,
            customer_price_cents=PRICE,
            pro_payout_cents=PAYOUT,
            platform_fee_cents=FEE,
            tax_cents=TAX,
        )
        async with as_status_writer(session):
            session.add(job)
            await session.flush()
        payment = Payment(
            request_id=request.id,
            quote_id=quote.id,
            customer_id=customer.id,
            amount_cents=PRICE,
            tax_cents=TAX,
            customer_total_cents=PRICE + TAX,
            platform_fee_cents=FEE,
            pro_payout_cents=PAYOUT,
            take_rate_bps=1500,
            currency="usd",
            status=PaymentStatus.SUCCEEDED,
            stripe_payment_intent_id=f"pi_probe69{tag}",
        )
        session.add(payment)
        await session.commit()
    try:
        yield CommittedBooking(
            sessions, job.id, _account(customer), audited, pro=_account(pro_user)
        )
    finally:
        async with sessions() as session:
            await session.execute(delete(Refund).where(Refund.job_id == job.id))
            await session.execute(delete(JobCancellation).where(JobCancellation.job_id == job.id))
            await session.execute(delete(JobEvent).where(JobEvent.job_id == job.id))
            await session.execute(delete(Job).where(Job.id == job.id))
            await session.execute(delete(Payment).where(Payment.id == payment.id))
            await session.execute(delete(Quote).where(Quote.id == quote.id))
            await session.execute(delete(ServiceRequest).where(ServiceRequest.id == request.id))
            await session.execute(delete(Address).where(Address.id == address.id))
            await session.execute(delete(ProProfile).where(ProProfile.id == profile.id))
            await session.execute(delete(User).where(User.id.in_([customer.id, pro_user.id])))
            await session.commit()
        await engine.dispose()


def _account(user: User) -> UserAccount:
    return UserAccount(
        id=user.id,
        email=user.email,
        role=user.role,
        locale=user.locale,
        status=user.status,
        public_code=user.public_code,
        created_at=user.created_at,
    )


def service(session: AsyncSession) -> CancellationService:
    return CancellationService(session, CancelConfig(1500, 1.0), NoJobLocationStore())


async def test_two_cancels_at_once_make_one_cancellation_and_one_refund(
    booking: CommittedBooking, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The customer's two devices cancel at once, each with its own key. The first holds the
    job's lock while it reads; the second waits on it (as Postgres reports), then finds the
    first cancellation and returns it. Bounded: without the lock the second never waits."""
    sessions = booking.sessions
    inside = asyncio.Event()
    go_on = asyncio.Event()
    original = CancellationRepository.of_job
    paused: list[bool] = []

    async def pausing(self: CancellationRepository, job_id: uuid.UUID) -> JobCancellation | None:
        if not paused:
            paused.append(True)
            inside.set()
            await go_on.wait()
        return await original(self, job_id)

    monkeypatch.setattr(CancellationRepository, "of_job", pausing)
    body = CustomerCancelIn(reason_code=CustomerCancelReason.CHANGED_MY_MIND)
    async with sessions() as first, sessions() as second:
        first_pid, second_pid = await backend_pid(first), await backend_pid(second)
        one = asyncio.create_task(
            service(first).cancel_as_customer(
                booking.customer, booking.job_id, body, RecordingQueue(), uuid.uuid4()
            )
        )
        other: asyncio.Task[Any] | None = None
        try:
            async with asyncio.timeout(5):
                await inside.wait()
            other = asyncio.create_task(
                service(second).cancel_as_customer(
                    booking.customer, booking.job_id, body, RecordingQueue(), uuid.uuid4()
                )
            )
            await wait_until_blocked(sessions, waiter=second_pid, holder=first_pid)
        finally:
            go_on.set()
            results = await asyncio.gather(one, *([other] if other else []))

    [(first_out, first_created), (second_out, second_created)] = results
    assert (first_created, second_created) == (True, False)
    assert first_out == second_out
    async with sessions() as check:
        rows = await check.scalar(
            select(func.count())
            .select_from(JobCancellation)
            .where(JobCancellation.job_id == booking.job_id)
        )
        refunds = await check.scalar(
            select(func.count()).select_from(Refund).where(Refund.job_id == booking.job_id)
        )
        status = await check.scalar(select(Job.status).where(Job.id == booking.job_id))
    assert (rows, refunds, status) == (1, 1, JobStatus.CANCELLED)
    assert booking.audited == [(booking.customer.id, "job.cancel")]


@pytest.mark.parametrize("first_party", [CancelParty.CUSTOMER, CancelParty.PRO])
async def test_the_customer_and_the_pro_cancelling_at_once_make_one_cancellation(
    booking: CommittedBooking, monkeypatch: pytest.MonkeyPatch, first_party: CancelParty
) -> None:
    """#69 part 2: the customer and the pro cancel at once. The first holds the job's lock;
    the other waits on it (as Postgres reports), then returns the first's cancellation: one
    row, one refund, one audit row, by the side that came first."""
    sessions = booking.sessions
    inside = asyncio.Event()
    go_on = asyncio.Event()
    original = CancellationRepository.of_job
    paused: list[bool] = []

    async def pausing(self: CancellationRepository, job_id: uuid.UUID) -> JobCancellation | None:
        if not paused:
            paused.append(True)
            inside.set()
            await go_on.wait()
        return await original(self, job_id)

    def by(party: CancelParty, session: AsyncSession) -> Any:
        if party is CancelParty.CUSTOMER:
            return service(session).cancel_as_customer(
                booking.customer,
                booking.job_id,
                CustomerCancelIn(reason_code=CustomerCancelReason.CHANGED_MY_MIND),
                RecordingQueue(),
                uuid.uuid4(),
            )
        return service(session).cancel_as_pro(
            booking.pro,
            booking.job_id,
            ProCancelIn(reason_code=ProCancelReason.CANNOT_MAKE_IT),
            RecordingQueue(),
            uuid.uuid4(),
        )

    second_party = CancelParty.PRO if first_party is CancelParty.CUSTOMER else CancelParty.CUSTOMER
    monkeypatch.setattr(CancellationRepository, "of_job", pausing)
    async with sessions() as first, sessions() as second:
        first_pid, second_pid = await backend_pid(first), await backend_pid(second)
        one = asyncio.create_task(by(first_party, first))
        other: asyncio.Task[Any] | None = None
        try:
            async with asyncio.timeout(5):
                await inside.wait()
            other = asyncio.create_task(by(second_party, second))
            await wait_until_blocked(sessions, waiter=second_pid, holder=first_pid)
        finally:
            go_on.set()
            results = await asyncio.gather(one, *([other] if other else []))

    [(first_out, first_created), (second_out, second_created)] = results
    assert (first_created, second_created) == (True, False)
    assert first_out.cancelled_by is second_out.cancelled_by is first_party
    async with sessions() as check:
        parties = (
            await check.scalars(
                select(JobCancellation.party).where(JobCancellation.job_id == booking.job_id)
            )
        ).all()
        refunds = await check.scalar(
            select(func.count()).select_from(Refund).where(Refund.job_id == booking.job_id)
        )
        status = await check.scalar(select(Job.status).where(Job.id == booking.job_id))
    assert (list(parties), refunds, status) == ([first_party], 1, JobStatus.CANCELLED)
    actor = booking.customer if first_party is CancelParty.CUSTOMER else booking.pro
    assert booking.audited == [(actor.id, "job.cancel")]
