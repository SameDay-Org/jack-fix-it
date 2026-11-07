"""The 48 h auto-confirm (#67): the cron that confirms, as the system, the completed jobs the
customer left unanswered past JOB_AUTO_CONFIRM_AFTER_HOURS, and its races with the customer's
own confirm (#66).

Real commits on separate connections; each test creates its own jobs and deletes them after.
The cron's clock is frozen in 2001 and the jobs completed around then, so no job another test
left in the database is ever due in these runs, and the summary's counts are exact. That holds
while one run of this file uses the test database at a time: two at once, or the rows of a run
killed before its cleanup, can make one summary count another's jobs.
"""

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncIterator, Awaitable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from redis.exceptions import RedisError
from sqlalchemy import URL, delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import Settings
from app.integrations.storage import Storage
from app.modules.addresses.models import Address
from app.modules.jobs import tasks
from app.modules.jobs.confirmation import AutoConfirmed, JobAutoConfirmer
from app.modules.jobs.execution import JobExecutionService
from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.jobs.service import JobStateMachine
from app.modules.jobs.tasks import auto_confirm_jobs
from app.modules.pros.models import ProProfile
from app.modules.pros.service import ProService
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole
from app.observability import JsonFormatter
from tests.conftest import LOCK_WAIT_DEADLINE_SECONDS, backend_pid, make_settings
from tests.helpers import as_status_writer
from tests.test_arrival_code import CONFIG
from tests.test_payment_webhooks import wait_until_any_waits_on
from tests.test_requests_api import RecordingQueue

WINDOW = timedelta(hours=48)
NOW = datetime(2001, 1, 1, 12, 0, tzinfo=UTC)
CUT_OFF = NOW - WINDOW
SUMMARY = "jobs_auto_confirmed"


class FrozenDatetime(datetime):
    """The cron's clock: datetime.now() is NOW."""

    @classmethod
    def now(cls, tz: Any = None) -> "FrozenDatetime":
        return cls.fromtimestamp(NOW.timestamp(), tz)


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tasks, "datetime", FrozenDatetime)


def no_storage() -> Storage:
    raise AssertionError("these jobs have no photo to sign")


@dataclass
class World:
    """A customer and a pro, committed; jobs added with add_job, all deleted after."""

    sessions: async_sessionmaker[AsyncSession]
    customer: UserAccount
    pro_user_id: uuid.UUID
    profile_id: uuid.UUID
    address_id: uuid.UUID
    settings: Settings = field(default_factory=lambda: make_settings())
    # ARQ's own pool in the worker's context: the cron's pushes (#65), recorded.
    queue: RecordingQueue = field(default_factory=RecordingQueue)
    jobs: list[tuple[uuid.UUID, uuid.UUID, uuid.UUID]] = field(default_factory=list)

    async def add_job(self, status: JobStatus, completed_at: datetime | None) -> Job:
        async with self.sessions() as session:
            request = ServiceRequest(
                customer_id=self.customer.id,
                address_id=self.address_id,
                description="Fix the faucet",
                origin=RequestOrigin.APP,
                status=RequestStatus.ACCEPTED,
            )
            async with as_status_writer(session):  # the database guard (#163)
                session.add(request)
                await session.flush()
            quote = Quote(
                request_id=request.id,
                pro_id=self.profile_id,
                amount_cents=10_000,
                scope="Faucet",
                duration_minutes=60,
                proposed_start_at=NOW - timedelta(days=5),
                expires_at=NOW - timedelta(days=6),
                status=QuoteStatus.ACCEPTED,
            )
            session.add(quote)
            await session.flush()
            job = Job(
                request_id=request.id,
                quote_id=quote.id,
                customer_id=self.customer.id,
                pro_id=self.profile_id,
                status=status,
                customer_price_cents=10_000,
                pro_payout_cents=8_500,
                platform_fee_cents=1_500,
                tax_cents=0,
                completed_at=completed_at,
            )
            async with as_status_writer(session):
                session.add(job)
                await session.flush()
            await session.commit()
        self.jobs.append((job.id, quote.id, request.id))
        return job

    def context(self) -> dict[str, Any]:
        """What the worker's startup puts in the cron's context."""
        return {"session_factory": self.sessions, "settings": self.settings, "redis": self.queue}

    def pushed(self) -> set[str]:
        """The jobs of the queued job_confirmed pushes."""
        return {job_id.removeprefix("push:job_confirmed:") for job_id in self.queue.jobs}

    async def state(self, job_id: uuid.UUID) -> tuple[JobStatus, datetime | None, list[JobEvent]]:
        async with self.sessions() as session:
            job = (await session.scalars(select(Job).where(Job.id == job_id))).one()
            events = (
                await session.scalars(
                    select(JobEvent)
                    .where(JobEvent.job_id == job_id)
                    .order_by(JobEvent.created_at, JobEvent.id)
                )
            ).all()
        return job.status, job.confirmed_at, list(events)


@pytest.fixture
async def world(test_database_url: URL) -> AsyncIterator[World]:
    engine = create_async_engine(test_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    tag = uuid.uuid4().hex[:12]
    async with sessions() as session:
        customer = User(email=f"c67-{tag}@x.com", password_hash="x", role=UserRole.CUSTOMER)
        pro_user = User(email=f"p67-{tag}@x.com", password_hash="x", role=UserRole.PRO)
        session.add_all([customer, pro_user])
        await session.flush()
        profile = ProProfile(user_id=pro_user.id)
        address = Address(
            user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
        )
        session.add_all([profile, address])
        await session.commit()
    built = World(
        sessions=sessions,
        customer=UserAccount(
            id=customer.id,
            email=customer.email,
            role=customer.role,
            locale=customer.locale,
            status=customer.status,
            public_code=customer.public_code,
            created_at=customer.created_at,
        ),
        pro_user_id=pro_user.id,
        profile_id=profile.id,
        address_id=address.id,
    )
    try:
        yield built
    finally:
        job_ids = [job_id for job_id, _, _ in built.jobs]
        async with sessions() as session:
            await session.execute(delete(JobEvent).where(JobEvent.job_id.in_(job_ids)))
            await session.execute(delete(Job).where(Job.id.in_(job_ids)))
            await session.execute(delete(Quote).where(Quote.id.in_([q for _, q, _ in built.jobs])))
            await session.execute(
                delete(ServiceRequest).where(ServiceRequest.id.in_([r for _, _, r in built.jobs]))
            )
            await session.execute(delete(Address).where(Address.id == address.id))
            await session.execute(delete(ProProfile).where(ProProfile.id == profile.id))
            await session.execute(delete(User).where(User.id.in_([customer.id, pro_user.id])))
            await session.commit()
        await engine.dispose()


def summaries(caplog: pytest.LogCaptureFixture) -> list[dict[str, int]]:
    """The counts of each run, in order."""
    return [
        {name: getattr(record, name) for name in ("confirmed", "skipped", "failed")}
        for record in caplog.records
        if record.getMessage() == SUMMARY
    ]


def counts(confirmed: int = 0, skipped: int = 0, failed: int = 0) -> dict[str, int]:
    return {"confirmed": confirmed, "skipped": skipped, "failed": failed}


@pytest.fixture
def logs(caplog: pytest.LogCaptureFixture) -> pytest.LogCaptureFixture:
    caplog.set_level(logging.DEBUG, logger=tasks.__name__)
    return caplog


def assert_system_confirmed(state: tuple[JobStatus, datetime | None, list[JobEvent]]) -> None:
    status, confirmed_at, events = state
    assert status is JobStatus.CONFIRMED
    assert confirmed_at is not None
    [event] = events
    assert (event.type, event.from_status, event.to_status, event.actor_id) == (
        "status_changed",
        JobStatus.COMPLETED,
        JobStatus.CONFIRMED,
        None,
    )


async def test_due_jobs_are_confirmed_by_the_system_at_the_window_boundary(
    world: World, logs: pytest.LogCaptureFixture
) -> None:
    at_boundary = await world.add_job(JobStatus.COMPLETED, CUT_OFF)
    long_due = await world.add_job(JobStatus.COMPLETED, CUT_OFF - timedelta(days=3))
    not_yet = await world.add_job(JobStatus.COMPLETED, CUT_OFF + timedelta(microseconds=1))

    await auto_confirm_jobs(world.context())

    assert_system_confirmed(await world.state(at_boundary.id))
    assert_system_confirmed(await world.state(long_due.id))
    assert await world.state(not_yet.id) == (JobStatus.COMPLETED, None, [])
    assert summaries(logs) == [counts(confirmed=2)]
    assert world.pushed() == {str(at_boundary.id), str(long_due.id)}


@pytest.mark.parametrize(
    "status",
    [
        JobStatus.DISPUTED,  # a problem is open: never auto-confirmed
        JobStatus.CONFIRMED,
        JobStatus.PAID_OUT,
        JobStatus.REFUNDED,
        JobStatus.IN_PROGRESS,
    ],
)
async def test_only_completed_jobs_are_confirmed(
    world: World, logs: pytest.LogCaptureFixture, status: JobStatus
) -> None:
    job = await world.add_job(status, CUT_OFF - timedelta(days=3))

    await auto_confirm_jobs(world.context())

    assert await world.state(job.id) == (status, None, [])
    assert summaries(logs) == [counts()]
    assert world.queue.before == []


async def test_a_job_disputed_after_the_read_is_skipped(
    world: World, logs: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    job = await world.add_job(JobStatus.COMPLETED, CUT_OFF - timedelta(hours=1))
    real_due = JobAutoConfirmer.due

    async def due_then_dispute(
        self: JobAutoConfirmer, *args: Any, **kwargs: Any
    ) -> list[uuid.UUID]:
        ids = await real_due(self, *args, **kwargs)
        # The customer reports a problem between the cron's read and its lock.
        async with world.sessions() as session:
            machine = JobStateMachine(session, ProService(session))
            await machine.transition(job.id, JobStatus.DISPUTED, world.customer)
            await session.commit()
        return ids

    monkeypatch.setattr(JobAutoConfirmer, "due", due_then_dispute)

    await auto_confirm_jobs(world.context())

    status, confirmed_at, events = await world.state(job.id)
    assert (status, confirmed_at) == (JobStatus.DISPUTED, None)
    assert [event.to_status for event in events] == [JobStatus.DISPUTED]
    assert summaries(logs) == [counts(skipped=1)]
    assert world.queue.before == []


async def test_confirm_if_due_checks_the_cut_off_again_under_the_lock(world: World) -> None:
    job = await world.add_job(JobStatus.COMPLETED, CUT_OFF)

    async with world.sessions() as session:
        early = CUT_OFF - timedelta(microseconds=1)
        assert await JobAutoConfirmer(session).confirm_if_due(job.id, early) is None
        assert await JobAutoConfirmer(session).confirm_if_due(uuid.uuid4(), CUT_OFF) is None
        confirmed = await JobAutoConfirmer(session).confirm_if_due(job.id, CUT_OFF)
        assert confirmed is not None
        assert confirmed == AutoConfirmed(
            job_id=job.id, pro_user_id=world.pro_user_id, public_code=confirmed.public_code
        )
        assert confirmed.public_code.startswith("JF-")
        await session.commit()

    assert_system_confirmed(await world.state(job.id))


async def test_overlapping_runs_confirm_each_job_once(
    world: World, logs: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = [await world.add_job(JobStatus.COMPLETED, CUT_OFF) for _ in range(3)]
    real_due = JobAutoConfirmer.due
    both_read = asyncio.Barrier(2)

    async def due_together(self: JobAutoConfirmer, *args: Any, **kwargs: Any) -> list[uuid.UUID]:
        ids = await real_due(self, *args, **kwargs)
        await both_read.wait()  # both runs hold the same due list before either confirms
        return ids

    monkeypatch.setattr(JobAutoConfirmer, "due", due_together)

    async with asyncio.timeout(30):
        await asyncio.gather(auto_confirm_jobs(world.context()), auto_confirm_jobs(world.context()))

    for job in jobs:
        assert_system_confirmed(await world.state(job.id))
    runs = summaries(logs)
    assert len(runs) == 2
    assert sum(run["confirmed"] for run in runs) == 3
    assert sum(run["skipped"] for run in runs) == 3
    assert all(run["failed"] == 0 for run in runs)
    # Only the run that confirmed a job pushes it: three enqueues, none deduplicated.
    assert len(world.queue.before) == 3
    assert world.pushed() == {str(job.id) for job in jobs}


async def test_a_failing_job_does_not_stop_the_batch(
    world: World, logs: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = sorted(
        [await world.add_job(JobStatus.COMPLETED, CUT_OFF) for _ in range(3)],
        key=lambda job: job.id,
    )
    failing = jobs[0]  # the first of the batch
    real_confirm = JobAutoConfirmer.confirm_if_due

    async def confirm_or_fail(
        self: JobAutoConfirmer, job_id: uuid.UUID, completed_before: datetime
    ) -> AutoConfirmed | None:
        confirmed = await real_confirm(self, job_id, completed_before)
        if job_id == failing.id:
            # After the transition: the failure must roll it back. The text must not be logged.
            raise RuntimeError("probe-secret-text-67")
        return confirmed

    monkeypatch.setattr(JobAutoConfirmer, "confirm_if_due", confirm_or_fail)

    await auto_confirm_jobs(world.context())

    assert await world.state(failing.id) == (JobStatus.COMPLETED, None, [])
    for job in jobs[1:]:
        assert_system_confirmed(await world.state(job.id))
    assert summaries(logs) == [counts(confirmed=2, failed=1)]
    assert world.pushed() == {str(job.id) for job in jobs[1:]}
    [failure] = [r for r in logs.records if r.getMessage() == "job_auto_confirm_failed"]
    assert (failure.levelno, failure.job_id, failure.error) == (  # type: ignore[attr-defined]
        logging.ERROR,
        str(failing.id),
        "RuntimeError",
    )
    assert "probe-secret-text-67" not in logs.text


async def test_the_next_run_confirms_a_job_that_failed(
    world: World, logs: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    job = await world.add_job(JobStatus.COMPLETED, CUT_OFF)

    async def fail(
        self: JobAutoConfirmer, job_id: uuid.UUID, completed_before: datetime
    ) -> AutoConfirmed | None:
        raise RuntimeError("database away")

    with monkeypatch.context() as patch:
        patch.setattr(JobAutoConfirmer, "confirm_if_due", fail)
        await auto_confirm_jobs(world.context())
    await auto_confirm_jobs(world.context())

    assert_system_confirmed(await world.state(job.id))
    assert summaries(logs) == [counts(failed=1), counts(confirmed=1)]


async def test_an_unreadable_batch_ends_the_run_with_its_summary(
    world: World, logs: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    job = await world.add_job(JobStatus.COMPLETED, CUT_OFF)

    async def unreadable(self: JobAutoConfirmer, *args: Any, **kwargs: Any) -> list[uuid.UUID]:
        raise ConnectionRefusedError("probe-secret-text-67")

    monkeypatch.setattr(JobAutoConfirmer, "due", unreadable)

    await auto_confirm_jobs(world.context())  # never raises

    assert await world.state(job.id) == (JobStatus.COMPLETED, None, [])
    [error] = [r for r in logs.records if r.getMessage() == "job_auto_confirm_unavailable"]
    assert error.error == "ConnectionRefusedError"  # type: ignore[attr-defined]
    assert summaries(logs) == [counts()]
    assert "probe-secret-text-67" not in logs.text


async def test_due_jobs_are_read_in_batches_by_id(
    world: World, logs: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = [await world.add_job(JobStatus.COMPLETED, CUT_OFF) for _ in range(5)]
    monkeypatch.setattr(tasks, "AUTO_CONFIRM_BATCH", 2)
    real_due = JobAutoConfirmer.due
    batches: list[list[uuid.UUID]] = []

    async def recorded(self: JobAutoConfirmer, *args: Any, **kwargs: Any) -> list[uuid.UUID]:
        ids = await real_due(self, *args, **kwargs)
        batches.append(ids)
        return ids

    monkeypatch.setattr(JobAutoConfirmer, "due", recorded)

    await auto_confirm_jobs(world.context())

    assert [len(batch) for batch in batches] == [2, 2, 1]
    assert [job_id for batch in batches for job_id in batch] == sorted(job.id for job in jobs)
    assert summaries(logs) == [counts(confirmed=5)]


async def test_cron_logs_carry_ids_and_counts_only(
    world: World, logs: pytest.LogCaptureFixture
) -> None:
    job = await world.add_job(JobStatus.COMPLETED, CUT_OFF)

    await auto_confirm_jobs(world.context())

    lines = [json.loads(JsonFormatter().format(record)) for record in logs.records]
    by_message = {line["message"]: line for line in lines}
    assert set(by_message) == {"job_auto_confirmed", SUMMARY}
    assert by_message["job_auto_confirmed"]["job_id"] == str(job.id)
    assert {key: by_message[SUMMARY][key] for key in ("confirmed", "skipped", "failed")} == counts(
        confirmed=1
    )
    text = "\n".join(json.dumps(line) for line in lines)
    assert world.customer.email not in text
    assert str(world.customer.id) not in text


async def test_the_push_is_queued_after_the_commit(world: World) -> None:
    job = await world.add_job(JobStatus.COMPLETED, CUT_OFF)
    seen: list[JobStatus | None] = []
    enqueue = world.queue.enqueue_job

    async def checked(function: str, *args: object, _job_id: str | None = None) -> object:
        async with world.sessions() as session:  # another connection: committed rows only
            seen.append(await session.scalar(select(Job.status).where(Job.id == job.id)))
        return await enqueue(function, *args, _job_id=_job_id)

    world.queue.enqueue_job = checked  # type: ignore[method-assign]

    await auto_confirm_jobs(world.context())

    assert seen == [JobStatus.CONFIRMED]
    [(function, args)] = world.queue.jobs.values()
    assert function == "send_push"
    assert args[:2] == (str(world.pro_user_id), f"job_confirmed:{job.id}")
    assert args[2:4] == ("push.job_confirmed.title", "push.job_confirmed.body")
    assert args[5] == f"/jobs/{job.id}"


async def test_a_failed_push_enqueue_never_fails_the_run(
    world: World, logs: pytest.LogCaptureFixture
) -> None:
    jobs = [await world.add_job(JobStatus.COMPLETED, CUT_OFF) for _ in range(2)]
    world.queue.failure = RedisError("probe-secret-text-67")
    logs.set_level(logging.INFO)

    await auto_confirm_jobs(world.context())

    for job in jobs:
        assert_system_confirmed(await world.state(job.id))
    assert summaries(logs) == [counts(confirmed=2)]
    failed = [r for r in logs.records if r.getMessage() == "push_enqueue_failed"]
    assert len(failed) == 2
    assert "probe-secret-text-67" not in logs.text


# The customer's confirm racing the cron: one transition and one event, whoever locks first.


async def customer_confirm(world: World, request_id: uuid.UUID) -> JobStatus:
    async with world.sessions() as session:
        view = await JobExecutionService(session, CONFIG, no_storage).confirm(
            world.customer, request_id, world.queue
        )
    return view.status


async def wait_for(task: Awaitable[Any]) -> Any:
    async with asyncio.timeout(10):
        return await task


async def test_customer_confirm_waiting_on_the_cron_answers_the_confirmed_job(
    world: World,
) -> None:
    job = await world.add_job(JobStatus.COMPLETED, CUT_OFF)

    async with world.sessions() as cron:
        cron_pid = await backend_pid(cron)
        # The cron confirms and holds its transaction open...
        assert await JobAutoConfirmer(cron).confirm_if_due(job.id, CUT_OFF) is not None
        # ...while the customer's confirm waits on the job's lock, then reads it confirmed.
        confirming = asyncio.create_task(customer_confirm(world, job.request_id))
        await wait_until_any_waits_on(world.sessions, cron_pid)
        await cron.commit()

    assert await wait_for(confirming) is JobStatus.CONFIRMED
    assert_system_confirmed(await world.state(job.id))
    assert world.queue.before == []  # the customer's answer was a repeat: no push


async def test_cron_waiting_on_the_customer_skips_the_job(
    world: World, logs: pytest.LogCaptureFixture
) -> None:
    job = await world.add_job(JobStatus.COMPLETED, CUT_OFF)

    async with world.sessions() as customer:
        customer_pid = await backend_pid(customer)
        # The customer confirms and holds the transaction open...
        machine = JobStateMachine(customer, ProService(customer))
        await machine.transition(job.id, JobStatus.CONFIRMED, world.customer)
        # ...while the cron, which read the job still completed, waits on its lock.
        run: asyncio.Task[None] = asyncio.create_task(auto_confirm_jobs(world.context()))
        await wait_until_any_waits_on(world.sessions, customer_pid)
        await customer.commit()

    await wait_for(run)
    status, confirmed_at, events = await world.state(job.id)
    assert (status, confirmed_at is not None) == (JobStatus.CONFIRMED, True)
    [event] = events
    assert (event.from_status, event.to_status, event.actor_id) == (
        JobStatus.COMPLETED,
        JobStatus.CONFIRMED,
        world.customer.id,
    )
    assert summaries(logs) == [counts(skipped=1)]
    assert world.queue.before == []  # the skipped run pushes nothing


async def lock_waiters(sessions: async_sessionmaker[AsyncSession], count: int) -> None:
    """Returns once `count` backends of the test database wait on a lock. A second waiter on a
    row queues behind the first one's tuple lock, so Postgres may name the first waiter, not the
    holder, as what blocks it: count every blocked backend."""
    query = text(
        "SELECT count(*) FROM pg_stat_activity "
        "WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0"
    )
    async with sessions() as monitor:
        try:
            async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
                while await monitor.scalar(query) < count:
                    pass
        except TimeoutError:
            pytest.fail(f"{count} backends never waited on a lock")


async def test_customer_and_a_cron_run_both_waiting_on_another_run(
    world: World, logs: pytest.LogCaptureFixture
) -> None:
    # A cron confirm holds the lock while the customer and a second run wait: one transition.
    job = await world.add_job(JobStatus.COMPLETED, CUT_OFF)

    async with world.sessions() as holder:
        holder_pid = await backend_pid(holder)
        assert await JobAutoConfirmer(holder).confirm_if_due(job.id, CUT_OFF) is not None
        waiters: list[asyncio.Task[Any]] = [
            asyncio.create_task(customer_confirm(world, job.request_id)),
            asyncio.create_task(auto_confirm_jobs(world.context())),
        ]
        await wait_until_any_waits_on(world.sessions, holder_pid)
        await lock_waiters(world.sessions, 2)  # both blocked on the job's lock
        await holder.commit()

    results = await wait_for(asyncio.gather(*waiters))
    assert results[0] is JobStatus.CONFIRMED
    assert_system_confirmed(await world.state(job.id))
    assert summaries(logs) == [counts(skipped=1)]
    assert world.queue.before == []
