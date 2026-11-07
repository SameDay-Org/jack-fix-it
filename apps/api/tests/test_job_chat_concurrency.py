"""A message and a status change on the same job run one after the other (#71).

Real commits on separate connections; the test creates its own rows and deletes them afterwards.
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import URL, delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.addresses.models import Address
from app.modules.chat.errors import ChatClosedError
from app.modules.chat.models import JobChatDelivery, JobChatRead, JobMessage
from app.modules.chat.repository import ChatRepository
from app.modules.chat.service import ChatConfig, ChatService
from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.jobs.service import JobPartiesReader, JobStateMachine
from app.modules.pros.models import ProProfile
from app.modules.pros.service import ProService
from app.modules.quotes.models import Quote
from app.modules.requests.models import RequestOrigin, ServiceRequest
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole
from tests.conftest import backend_pid, wait_until_blocked
from tests.helpers import as_status_writer

NOW = datetime(2026, 11, 7, 12, 0, tzinfo=UTC)
CONFIG = ChatConfig(
    list_default_limit=20,
    list_max_limit=50,
    original_cipher=None,
    original_retention=timedelta(days=90),
    offender_threshold=3,
    offender_window_seconds=7 * 24 * 60 * 60,
)


@dataclass(frozen=True)
class CommittedJob:
    sessions: async_sessionmaker[AsyncSession]
    job_id: uuid.UUID
    customer: UserAccount
    pro: UserAccount


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


@pytest.fixture
async def committed_job(test_database_url: URL) -> AsyncIterator[CommittedJob]:
    """A completed job (its chat open) with every row it needs, all committed."""
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
        async with as_status_writer(session):  # the database guard (#163)
            session.add(job)
            await session.flush()
        await session.commit()
        ids = (customer.id, pro_user.id, profile.id, address.id, request.id, quote.id, job.id)
        accounts = (_account(customer), _account(pro_user))
    try:
        yield CommittedJob(sessions, job.id, *accounts)
    finally:
        customer_id, pro_user_id, profile_id, address_id, request_id, quote_id, job_id = ids
        async with sessions() as session:
            await session.execute(delete(JobChatRead).where(JobChatRead.job_id == job_id))
            await session.execute(delete(JobChatDelivery).where(JobChatDelivery.job_id == job_id))
            await session.execute(delete(JobMessage).where(JobMessage.job_id == job_id))
            await session.execute(delete(JobEvent).where(JobEvent.job_id == job_id))
            await session.execute(delete(Job).where(Job.id == job_id))
            await session.execute(delete(Quote).where(Quote.id == quote_id))
            await session.execute(delete(ServiceRequest).where(ServiceRequest.id == request_id))
            await session.execute(delete(Address).where(Address.id == address_id))
            await session.execute(delete(ProProfile).where(ProProfile.id == profile_id))
            await session.execute(delete(User).where(User.id.in_([customer_id, pro_user_id])))
            await session.commit()
        await engine.dispose()


async def _messages(world: CommittedJob) -> list[JobMessage]:
    async with world.sessions() as session:
        statement = (
            select(JobMessage)
            .where(JobMessage.job_id == world.job_id)
            .order_by(JobMessage.created_at, JobMessage.id)
        )
        return list((await session.scalars(statement)).all())


async def _status(world: CommittedJob) -> JobStatus:
    async with world.sessions() as session:
        status = await session.scalar(select(Job.status).where(Job.id == world.job_id))
        assert status is not None
        return status


async def test_a_message_waiting_on_a_closing_job_is_refused(
    committed_job: CommittedJob,
) -> None:
    world = committed_job
    async with world.sessions() as closing, world.sessions() as chatting:
        # The customer confirms: the job row is locked until the commit.
        await JobStateMachine(closing, ProService(closing)).transition(
            world.job_id, JobStatus.CONFIRMED, world.customer
        )
        holder = await backend_pid(closing)
        waiter = await backend_pid(chatting)
        send = asyncio.create_task(
            ChatService(chatting, CONFIG).send(world.pro, world.job_id, "on my way back")
        )
        await wait_until_blocked(world.sessions, waiter=waiter, holder=holder)
        await closing.commit()

        with pytest.raises(ChatClosedError):
            await send
        await chatting.rollback()

    assert await _status(world) is JobStatus.CONFIRMED
    assert await _messages(world) == []


async def test_a_status_change_waits_for_a_message_being_written(
    committed_job: CommittedJob,
) -> None:
    world = committed_job
    async with world.sessions() as chatting, world.sessions() as closing:
        # The chat's lock, as send() takes it, held while the message is written.
        parties = await JobPartiesReader(chatting, ProService(chatting)).parties(
            world.job_id, lock=True
        )
        assert parties is not None
        assert parties.chat_open
        holder = await backend_pid(chatting)
        waiter = await backend_pid(closing)
        confirm = asyncio.create_task(
            JobStateMachine(closing, ProService(closing)).transition(
                world.job_id, JobStatus.CONFIRMED, world.customer
            )
        )
        await wait_until_blocked(world.sessions, waiter=waiter, holder=holder)
        chatting.add(
            JobMessage(job_id=world.job_id, sender_id=world.pro.id, body="done", redacted=False)
        )
        await chatting.commit()

        assert await confirm is JobStatus.CONFIRMED
        await closing.commit()

    assert [m.body for m in await _messages(world)] == ["done"]
    assert await _status(world) is JobStatus.CONFIRMED


async def test_concurrent_messages_commit_in_created_at_order(
    committed_job: CommittedJob,
) -> None:
    # Two sends on one job wait for each other, so the later commit has the later created_at:
    # a read marker set on the first can never skip the second.
    world = committed_job
    async with world.sessions() as first, world.sessions() as second:
        parties = await JobPartiesReader(first, ProService(first)).parties(world.job_id, lock=True)
        assert parties is not None
        holder = await backend_pid(first)
        waiter = await backend_pid(second)
        send = asyncio.create_task(
            ChatService(second, CONFIG).send(world.customer, world.job_id, "second")
        )
        await wait_until_blocked(world.sessions, waiter=waiter, holder=holder)
        # The first was taken (its transaction began) before the second, and commits first.
        first.add(
            JobMessage(job_id=world.job_id, sender_id=world.pro.id, body="first", redacted=False)
        )
        await first.commit()
        out = await send

    stored = await _messages(world)
    assert [m.body for m in stored] == ["first", "second"]
    assert stored[1].id == out.id
    assert stored[0].created_at < stored[1].created_at


@pytest.mark.parametrize("newer_first", [True, False], ids=["newer_first", "older_first"])
async def test_racing_delivered_markers_never_move_back(
    committed_job: CommittedJob, newer_first: bool
) -> None:
    # #331: two listings move the customer's delivered marker at once. One transaction writes
    # it and holds the row; the other waits for it, and the newer message wins in either order.
    world = committed_job
    async with world.sessions() as session:
        older, newer = (
            JobMessage(
                job_id=world.job_id,
                sender_id=world.pro.id,
                body=body,
                redacted=False,
                created_at=at,
            )
            for body, at in (("older", NOW), ("newer", NOW + timedelta(seconds=1)))
        )
        session.add_all([older, newer])
        await session.commit()
    first_message, second_message = (newer, older) if newer_first else (older, newer)

    async def late(session: AsyncSession) -> None:
        await ChatRepository(session).move_delivered(
            world.job_id, world.customer.id, second_message
        )
        await session.commit()

    async with world.sessions() as first, world.sessions() as second:
        await ChatRepository(first).move_delivered(world.job_id, world.customer.id, first_message)
        holder = await backend_pid(first)
        waiter = await backend_pid(second)
        task = asyncio.create_task(late(second))
        await wait_until_blocked(world.sessions, waiter=waiter, holder=holder)
        await first.commit()
        await task

    async with world.sessions() as session:
        delivered = await session.scalar(
            select(JobChatDelivery.last_delivered_message_id)
            .where(JobChatDelivery.job_id == world.job_id)
            .where(JobChatDelivery.user_id == world.customer.id)
        )
    assert delivered == newer.id
