"""Two concurrent transitions from the same state: exactly one wins (#60).

Real commits on two connections; the test creates its own rows and deletes them afterwards.
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import URL, delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.addresses.models import Address
from app.modules.jobs.errors import InvalidTransitionError
from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.jobs.service import JobStateMachine
from app.modules.pros.models import ProProfile
from app.modules.pros.service import ProService
from app.modules.quotes.models import Quote
from app.modules.requests.models import RequestOrigin, ServiceRequest
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole

LOCK_WAIT_DEADLINE_SECONDS = 5
NOW = datetime(2026, 10, 21, 12, 0, tzinfo=UTC)


@dataclass(frozen=True)
class CommittedJob:
    sessions: async_sessionmaker[AsyncSession]
    job_id: uuid.UUID
    customer: UserAccount


@pytest.fixture
async def committed_job(test_database_url: URL) -> AsyncIterator[CommittedJob]:
    """A completed job with its customer, pro, address, request and quote, all committed."""
    engine = create_async_engine(test_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    tag = uuid.uuid4().hex[:12]
    async with sessions() as session:
        customer = User(email=f"c-{tag}@x.com", password_hash="x", role=UserRole.CUSTOMER)
        pro_user = User(email=f"p-{tag}@x.com", password_hash="x", role=UserRole.PRO)
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
            description="Paint",
            origin=RequestOrigin.APP,
        )
        session.add(request)
        await session.flush()
        quote = Quote(
            request_id=request.id,
            pro_id=profile.id,
            amount_cents=10_000,
            scope="Walls",
            duration_minutes=60,
            proposed_start_at=NOW + timedelta(days=1),
            expires_at=NOW,
        )
        session.add(quote)
        await session.flush()
        job = Job(
            request_id=request.id,
            quote_id=quote.id,
            customer_id=customer.id,
            pro_id=profile.id,
            status=JobStatus.COMPLETED,
            customer_price_cents=10_000,
            pro_payout_cents=8_500,
            platform_fee_cents=1_500,
            tax_cents=0,
        )
        session.add(job)
        await session.commit()
        ids = (customer.id, pro_user.id, profile.id, address.id, request.id, quote.id, job.id)
        account = UserAccount(
            id=customer.id,
            email=customer.email,
            role=customer.role,
            locale=customer.locale,
            status=customer.status,
        )
    try:
        yield CommittedJob(sessions=sessions, job_id=job.id, customer=account)
    finally:
        customer_id, pro_user_id, profile_id, address_id, request_id, quote_id, job_id = ids
        async with sessions() as session:
            await session.execute(delete(JobEvent).where(JobEvent.job_id == job_id))
            await session.execute(delete(Job).where(Job.id == job_id))
            await session.execute(delete(Quote).where(Quote.id == quote_id))
            await session.execute(delete(ServiceRequest).where(ServiceRequest.id == request_id))
            await session.execute(delete(Address).where(Address.id == address_id))
            await session.execute(delete(ProProfile).where(ProProfile.id == profile_id))
            await session.execute(delete(User).where(User.id.in_([customer_id, pro_user_id])))
            await session.commit()
        await engine.dispose()


async def backend_pid(session: AsyncSession) -> int:
    pid = await session.scalar(text("SELECT pg_backend_pid()"))
    assert isinstance(pid, int)
    return pid


async def wait_until_blocked(
    sessions: async_sessionmaker[AsyncSession], *, waiter: int, holder: int
) -> None:
    """Returns once Postgres reports backend `waiter` waiting on a lock `holder` holds."""
    query = text("SELECT CAST(:holder AS integer) = ANY(pg_blocking_pids(:waiter))")
    async with sessions() as monitor:
        try:
            async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
                while not await monitor.scalar(query, {"holder": holder, "waiter": waiter}):
                    pass
        except TimeoutError:
            pytest.fail(
                f"backend {waiter} never waited on a lock of backend {holder} "
                f"within {LOCK_WAIT_DEADLINE_SECONDS} s"
            )


async def test_two_concurrent_confirms_one_succeeds_one_409(committed_job: CommittedJob) -> None:
    # The customer's two devices confirm at once.
    sessions = committed_job.sessions
    async with sessions() as first, sessions() as second:
        first_pid, second_pid = await backend_pid(first), await backend_pid(second)
        first_machine = JobStateMachine(first, ProService(first))
        second_machine = JobStateMachine(second, ProService(second))

        # The first confirm locks the job and holds its transaction open...
        await first_machine.transition(
            committed_job.job_id, JobStatus.CONFIRMED, committed_job.customer
        )
        # ...while the second one waits on that lock, as Postgres reports, then commits.
        second_confirm = asyncio.create_task(
            second_machine.transition(
                committed_job.job_id, JobStatus.CONFIRMED, committed_job.customer
            )
        )
        await wait_until_blocked(sessions, waiter=second_pid, holder=first_pid)
        await first.commit()

        # The second one now reads the confirmed job: confirmed -> confirmed is not an edge.
        with pytest.raises(InvalidTransitionError):
            await second_confirm
        await second.rollback()

    async with sessions() as check:
        job = await check.get(Job, committed_job.job_id)
        events = await check.scalar(
            select(func.count())
            .select_from(JobEvent)
            .where(JobEvent.job_id == committed_job.job_id)
        )
    assert job is not None
    assert job.status is JobStatus.CONFIRMED
    assert events == 1
