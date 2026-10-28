"""The quote expiry cron (D9.4, #51 part 1): pending quotes past their expires_at expire, and a
quote_ready request left with no pending or accepted quote backs out to finding_pro."""

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import URL, delete, select, text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.integrations.storage import get_storage
from app.modules.addresses.models import Address
from app.modules.auth import security
from app.modules.categories.models import Category
from app.modules.dispatch.models import DispatchStatus, RequestDispatch
from app.modules.pros.models import ProProfile
from app.modules.quotes import tasks
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.quotes.repository import QuoteRepository
from app.modules.quotes.schemas import QuoteCreate
from app.modules.quotes.service import QuoteExpiryService, QuoteService, RequestExpiry
from app.modules.quotes.tasks import expire_quotes
from app.modules.requests.customer_status import REQUEST_CUSTOMER_STATUS
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.settings.models import Setting
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole
from app.observability import JsonFormatter
from app.queue import get_job_queue
from tests.conftest import LOCK_WAIT_DEADLINE_SECONDS, TEST_JWT_SECRET, backend_pid
from tests.helpers import as_status_writer
from tests.test_opportunities_api import EMAIL, LINE1, PHONE, Pro, World, build_world, make_request
from tests.test_quotes_api import TTL_HOURS, body, quotes_of, status_of
from tests.test_requests_api import ENQUEUE_TIMEOUT, FakeStorage, RecordingQueue

SCOPE = "Fix the faucet, probe-expiry-scope"
AMOUNT = 87_654
COUNTS = ("expired", "requests_backed_out", "failed")

Sessions = Callable[[], AbstractAsyncContextManager[AsyncSession]]


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    return await build_world(db_session)


@pytest.fixture
def storage(app: FastAPI) -> FakeStorage:
    """What GET /v1/requests/{id} depends on: storage (presigned URLs) and the job queue."""
    fake = FakeStorage()
    app.dependency_overrides[get_storage] = lambda: fake
    queue = RecordingQueue()
    app.dependency_overrides[get_job_queue] = lambda: queue
    return fake


def in_session(session: AsyncSession) -> Sessions:
    """A session factory for the cron that hands out the test's rolled-back session. A block
    that fails rolls back what it did, as closing a real session does."""

    @asynccontextmanager
    async def factory() -> AsyncIterator[AsyncSession]:
        try:
            yield session
        except BaseException:
            await session.rollback()
            raise

    return factory


async def sweep(session: AsyncSession, caplog: pytest.LogCaptureFixture) -> dict[str, int]:
    """One cron run on the test's session, with its logs alone in caplog; its summary."""
    await session.commit()  # the test's rows: a failed request's rollback keeps them
    caplog.clear()
    with caplog.at_level(logging.INFO):
        await expire_quotes({"session_factory": in_session(session)})
    [summary] = [r for r in caplog.records if r.message == "quotes_expired"]
    return {key: summary.__dict__[key] for key in COUNTS}


async def add_quote(
    session: AsyncSession,
    request_id: uuid.UUID,
    pro_id: uuid.UUID,
    expires_at: datetime,
    status: QuoteStatus = QuoteStatus.PENDING,
) -> uuid.UUID:
    quote = Quote(
        request_id=request_id,
        pro_id=pro_id,
        amount_cents=AMOUNT,
        scope=SCOPE,
        duration_minutes=60,
        proposed_start_at=datetime.now(UTC) + timedelta(days=2),
        expires_at=expires_at,
        status=status,
    )
    session.add(quote)
    await session.flush()
    return quote.id


def past() -> datetime:
    return datetime.now(UTC) - timedelta(minutes=1)


def future() -> datetime:
    return datetime.now(UTC) + timedelta(hours=1)


async def statuses(session: AsyncSession, request_id: uuid.UUID) -> dict[uuid.UUID, QuoteStatus]:
    return {quote.id: quote.status for quote in await quotes_of(session, request_id)}


def changes_of(caplog: pytest.LogCaptureFixture, request_id: uuid.UUID) -> list[tuple[str, str]]:
    return [
        (r.__dict__["from_status"], r.__dict__["to_status"])
        for r in caplog.records
        if r.message == "request_status_changed"
        and r.__dict__["service_request_id"] == str(request_id)
    ]


def expired_logged(caplog: pytest.LogCaptureFixture, request_id: uuid.UUID) -> list[str]:
    return [
        r.__dict__["quote_id"]
        for r in caplog.records
        if r.message == "quote_expired" and r.__dict__["service_request_id"] == str(request_id)
    ]


def customer_headers(world: World) -> dict[str, str]:
    token = security.create_access_token(
        user_id=world.customer_id,
        role=UserRole.CUSTOMER,
        secret=TEST_JWT_SECRET,
        ttl_seconds=900,
        now=datetime.now(UTC),
    )
    return {"Authorization": f"Bearer {token}"}


async def quote_ready(db_session: AsyncSession, world: World) -> uuid.UUID:
    return await make_request(db_session, world, RequestStatus.QUOTE_READY)


def pro(world: World, which: str = "me") -> uuid.UUID:
    chosen: Pro = world.me if which == "me" else world.other
    return chosen.profile_id


async def test_expires_pending_quotes_past_their_time(
    db_session: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    request_id = await quote_ready(db_session, world)
    first = await add_quote(db_session, request_id, pro(world), past())
    second = await add_quote(db_session, request_id, pro(world, "other"), past())

    counts = await sweep(db_session, caplog)

    assert await statuses(db_session, request_id) == {
        first: QuoteStatus.EXPIRED,
        second: QuoteStatus.EXPIRED,
    }
    assert sorted(expired_logged(caplog, request_id)) == sorted([str(first), str(second)])
    # Other committed rows of the test database may be due too: at least these two.
    assert counts["expired"] >= 2
    assert counts["failed"] == 0


async def test_keeps_pending_quotes_not_yet_expired(db_session: AsyncSession, world: World) -> None:
    request_id = await quote_ready(db_session, world)
    expires_at = datetime.now(UTC) + timedelta(hours=2)
    quote_id = await add_quote(db_session, request_id, pro(world), expires_at)
    service = QuoteExpiryService(db_session)
    just_before = expires_at - timedelta(seconds=1)

    assert request_id not in await service.requests_due(just_before, None, 10_000)
    assert await service.expire_request(request_id, just_before) == RequestExpiry((), False)
    assert await statuses(db_session, request_id) == {quote_id: QuoteStatus.PENDING}
    assert await status_of(db_session, request_id) is RequestStatus.QUOTE_READY

    # Due at its expires_at exactly: the readers (#188, #189) show it only before then.
    assert request_id in await service.requests_due(expires_at, None, 10_000)
    assert await service.expire_request(request_id, expires_at) == RequestExpiry((quote_id,), True)
    assert await statuses(db_session, request_id) == {quote_id: QuoteStatus.EXPIRED}


async def test_never_expires_accepted_quotes(
    db_session: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    # The payment is pending (#58, #61): the accepted quote stays, past its expires_at or not.
    request_id = await make_request(db_session, world, RequestStatus.ACCEPTED)
    accepted = await add_quote(db_session, request_id, pro(world), past(), QuoteStatus.ACCEPTED)

    await sweep(db_session, caplog)
    # The sweep never picks the request (no pending quote); expiring it directly changes nothing.
    service = QuoteExpiryService(db_session)
    assert await service.expire_request(request_id, datetime.now(UTC)) == RequestExpiry((), False)

    assert await statuses(db_session, request_id) == {accepted: QuoteStatus.ACCEPTED}
    assert await status_of(db_session, request_id) is RequestStatus.ACCEPTED
    assert expired_logged(caplog, request_id) == []


async def test_request_backs_out_when_no_live_quote_remains(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
) -> None:
    request_id = await quote_ready(db_session, world)
    due = await add_quote(db_session, request_id, pro(world), past())
    # A decided quote is not live, and the sweep leaves it as it is, due or not.
    rejected = await add_quote(
        db_session, request_id, pro(world, "other"), past(), QuoteStatus.REJECTED
    )

    counts = await sweep(db_session, caplog)

    assert await status_of(db_session, request_id) is RequestStatus.FINDING_PRO
    assert await statuses(db_session, request_id) == {
        due: QuoteStatus.EXPIRED,
        rejected: QuoteStatus.REJECTED,
    }
    assert changes_of(caplog, request_id) == [("quote_ready", "finding_pro")]
    [change] = [
        r
        for r in caplog.records
        if r.message == "request_status_changed"
        and r.__dict__["service_request_id"] == str(request_id)
    ]
    assert (change.__dict__["actor_kind"], change.__dict__["actor_id"]) == ("system", None)
    assert counts["requests_backed_out"] >= 1
    # What the customer sees again, through the existing mapping.
    assert REQUEST_CUSTOMER_STATUS[RequestStatus.FINDING_PRO] == "customerStatus.findingAPro"
    response = await db_client.get(f"/v1/requests/{request_id}", headers=customer_headers(world))
    assert response.status_code == 200, response.text
    assert response.json()["customer_status"] == "customerStatus.findingAPro"


@pytest.mark.parametrize("live", [QuoteStatus.PENDING, QuoteStatus.ACCEPTED])
async def test_request_stays_quote_ready_while_another_quote_is_live(
    db_session: AsyncSession, world: World, live: QuoteStatus, caplog: pytest.LogCaptureFixture
) -> None:
    request_id = await quote_ready(db_session, world)
    due = await add_quote(db_session, request_id, pro(world), past())
    other = await add_quote(db_session, request_id, pro(world, "other"), future(), live)

    await sweep(db_session, caplog)

    assert await statuses(db_session, request_id) == {due: QuoteStatus.EXPIRED, other: live}
    assert await status_of(db_session, request_id) is RequestStatus.QUOTE_READY
    assert changes_of(caplog, request_id) == []


@pytest.mark.parametrize(
    "status", [RequestStatus.ACCEPTED, RequestStatus.EXPIRED, RequestStatus.CANCELLED]
)
async def test_requests_in_other_statuses_are_left_alone(
    db_session: AsyncSession, world: World, status: RequestStatus, caplog: pytest.LogCaptureFixture
) -> None:
    # The due quote expires: its time passed. The request keeps its status, and an accepted
    # request keeps its accepted quote.
    request_id = await make_request(db_session, world, status)
    due = await add_quote(db_session, request_id, pro(world), past())
    expected = {due: QuoteStatus.EXPIRED}
    if status is RequestStatus.ACCEPTED:
        accepted = await add_quote(
            db_session, request_id, pro(world, "other"), past(), QuoteStatus.ACCEPTED
        )
        expected[accepted] = QuoteStatus.ACCEPTED

    counts = await sweep(db_session, caplog)

    assert await statuses(db_session, request_id) == expected
    assert await status_of(db_session, request_id) is status
    assert changes_of(caplog, request_id) == []
    assert counts["failed"] == 0


async def test_second_run_changes_nothing(
    db_session: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    backed = await quote_ready(db_session, world)
    await add_quote(db_session, backed, pro(world), past())
    kept = await quote_ready(db_session, world)
    await add_quote(db_session, kept, pro(world), past())
    await add_quote(db_session, kept, pro(world, "other"), future())
    await sweep(db_session, caplog)

    async def state() -> dict[uuid.UUID, object]:
        return {
            r: (await status_of(db_session, r), await statuses(db_session, r))
            for r in (backed, kept)
        }

    before = await state()
    assert await status_of(db_session, backed) is RequestStatus.FINDING_PRO

    counts = await sweep(db_session, caplog)

    assert await state() == before
    assert counts == {"expired": 0, "requests_backed_out": 0, "failed": 0}
    noisy = {"quote_expired", "request_status_changed", "quote_expiry_failed"}
    assert not [r for r in caplog.records if r.message in noisy]


async def test_batches_reach_every_due_request_once(
    db_session: AsyncSession,
    world: World,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(tasks, "EXPIRY_BATCH", 2)
    requests = [await quote_ready(db_session, world) for _ in range(5)]
    for request_id in requests:
        await add_quote(db_session, request_id, pro(world), past())
    seen: list[uuid.UUID] = []
    expire = QuoteExpiryService.expire_request

    async def counting(
        self: QuoteExpiryService, request_id: uuid.UUID, now: datetime
    ) -> RequestExpiry:
        seen.append(request_id)
        return await expire(self, request_id, now)

    monkeypatch.setattr(QuoteExpiryService, "expire_request", counting)

    await sweep(db_session, caplog)

    assert sorted(r for r in seen if r in requests) == sorted(requests)
    assert len(seen) == len(set(seen))
    for request_id in requests:
        assert await status_of(db_session, request_id) is RequestStatus.FINDING_PRO


async def test_failure_on_one_request_does_not_stop_the_run(
    db_session: AsyncSession,
    world: World,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    # The broken request comes first (by id), so the run has to go on past it.
    broken, fine = sorted(
        [await quote_ready(db_session, world), await quote_ready(db_session, world)]
    )
    broken_quote = await add_quote(db_session, broken, pro(world), past())
    fine_quote = await add_quote(db_session, fine, pro(world), past())
    canary = f"canary-{uuid.uuid4().hex}"
    has_live = QuoteRepository.has_live

    async def failing(self: QuoteRepository, request_id: uuid.UUID) -> bool:
        # After the request's quote was expired: the failure must take that back too.
        if request_id == broken:
            statement = f"SELECT '{canary}'"
            raise ProgrammingError(statement, {"value": canary}, Exception("permission denied"))
        return await has_live(self, request_id)

    monkeypatch.setattr(QuoteRepository, "has_live", failing)

    counts = await sweep(db_session, caplog)

    assert counts["failed"] == 1
    assert await statuses(db_session, broken) == {broken_quote: QuoteStatus.PENDING}
    assert await status_of(db_session, broken) is RequestStatus.QUOTE_READY
    assert await statuses(db_session, fine) == {fine_quote: QuoteStatus.EXPIRED}
    assert await status_of(db_session, fine) is RequestStatus.FINDING_PRO
    assert expired_logged(caplog, broken) == []
    [failure] = [r for r in caplog.records if r.message == "quote_expiry_failed"]
    assert failure.levelno == logging.ERROR
    assert failure.__dict__["service_request_id"] == str(broken)
    assert failure.__dict__["error"] == "ProgrammingError"
    assert failure.exc_info is None
    assert canary not in "\n".join(JsonFormatter().format(r) for r in caplog.records)


async def test_an_unreadable_batch_ends_the_run_without_raising(
    caplog: pytest.LogCaptureFixture,
) -> None:
    canary = f"canary-{uuid.uuid4().hex}"

    def unreachable() -> AbstractAsyncContextManager[AsyncSession]:
        statement = f"SELECT '{canary}'"
        raise ProgrammingError(statement, {"value": canary}, Exception("connection refused"))

    with caplog.at_level(logging.INFO):
        await expire_quotes({"session_factory": unreachable})

    [failure] = [r for r in caplog.records if r.message == "quote_expiry_unavailable"]
    assert (failure.levelno, failure.__dict__["error"]) == (logging.ERROR, "ProgrammingError")
    [summary] = [r for r in caplog.records if r.message == "quotes_expired"]
    assert [summary.__dict__[key] for key in COUNTS] == [0, 0, 0]
    assert canary not in "\n".join(JsonFormatter().format(r) for r in caplog.records)


async def test_logs_carry_ids_and_counts_only(
    db_session: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    request_id = await quote_ready(db_session, world)
    quote_id = await add_quote(db_session, request_id, pro(world), past())

    await sweep(db_session, caplog)

    output = "\n".join(JsonFormatter().format(r) for r in caplog.records)
    for value in ("probe-expiry-scope", str(AMOUNT), EMAIL, PHONE, LINE1):
        assert value not in output
    standard = set(logging.makeLogRecord({}).__dict__) | {"message"}
    [summary] = [r for r in caplog.records if r.message == "quotes_expired"]
    assert set(summary.__dict__) - standard == set(COUNTS)
    assert all(type(summary.__dict__[key]) is int for key in COUNTS)
    [detail] = [
        r
        for r in caplog.records
        if r.message == "quote_expired" and r.__dict__["quote_id"] == str(quote_id)
    ]
    assert set(detail.__dict__) - standard == {"quote_id", "service_request_id"}
    assert detail.__dict__["service_request_id"] == str(request_id)


# Real commits on separate connections: the rolled-back db_session cannot show two runs, or a
# run and a quote, taking turns on a request's lock. The rows are deleted afterwards.


@dataclass(frozen=True)
class Committed:
    sessions: async_sessionmaker[AsyncSession]
    request_id: uuid.UUID
    due_quote_id: uuid.UUID
    pro: UserAccount  # the second pro, dispatched and not quoted yet
    dispatch_id: uuid.UUID  # that pro's dispatch


@pytest.fixture
async def committed(test_database_url: URL) -> AsyncIterator[Committed]:
    """A quote_ready request whose only quote, by one pro, is due; a second pro dispatched."""
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
            status=RequestStatus.QUOTE_READY,
        )
        async with as_status_writer(session):  # the database guard (#163)
            session.add(request)
            await session.flush()
        now = datetime.now(UTC)
        quoted, waiting = (
            RequestDispatch(
                request_id=request.id,
                pro_id=profiles[0].id,
                status=DispatchStatus.QUOTED,
                sent_at=now,
            ),
            RequestDispatch(request_id=request.id, pro_id=profiles[1].id, sent_at=now),
        )
        session.add_all([quoted, waiting])
        due_quote_id = await add_quote(session, request.id, profiles[0].id, past())
        # Real commits: keep the migration's seeded value and put it back afterwards.
        seeded_ttl = await session.scalar(
            select(Setting.value).where(Setting.key == "quote_ttl_hours")
        )
        await session.execute(delete(Setting).where(Setting.key == "quote_ttl_hours"))
        session.add(Setting(key="quote_ttl_hours", value=TTL_HOURS))
        await session.commit()
        second = pro_users[1]
        account = UserAccount(
            id=second.id,
            email=second.email,
            role=second.role,
            locale=second.locale,
            status=second.status,
        )
    try:
        yield Committed(sessions, request.id, due_quote_id, account, waiting.id)
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
            if seeded_ttl is not None:
                session.add(Setting(key="quote_ttl_hours", value=seeded_ttl))
            await session.commit()
        await engine.dispose()


async def wait_until_waited_on(sessions: async_sessionmaker[AsyncSession], holder: int) -> None:
    """Returns once some backend waits on a lock backend `holder` holds; fails after the
    deadline. Each poll is the query itself, on its own connection."""
    query = text(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity"
        " WHERE CAST(:holder AS integer) = ANY(pg_blocking_pids(pid)))"
    )
    async with sessions() as monitor:
        try:
            async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
                while not await monitor.scalar(query, {"holder": holder}):
                    pass
        except TimeoutError:
            pytest.fail(f"nothing waited on backend {holder} within {LOCK_WAIT_DEADLINE_SECONDS} s")


@dataclass
class Hold:
    """Holds the first matching call's transaction, with the request's lock it took before the
    call, until another backend waits on it. `held` is set once it holds."""

    committed: Committed
    held: asyncio.Event

    async def after(self, session: AsyncSession, request_id: uuid.UUID) -> None:
        if request_id != self.committed.request_id or self.held.is_set():
            return
        pid = await backend_pid(session)
        self.held.set()
        await wait_until_waited_on(self.committed.sessions, pid)


def hold_sweep(monkeypatch: pytest.MonkeyPatch, committed: Committed) -> asyncio.Event:
    """The sweep holds the request's lock right after expiring its due quote."""
    hold = Hold(committed, asyncio.Event())
    expire_due = QuoteRepository.expire_due

    async def holding(
        self: QuoteRepository, request_id: uuid.UUID, now: datetime
    ) -> list[uuid.UUID]:
        expired = await expire_due(self, request_id, now)
        await hold.after(self._session, request_id)
        return expired

    monkeypatch.setattr(QuoteRepository, "expire_due", holding)
    return hold.held


def hold_quote(monkeypatch: pytest.MonkeyPatch, committed: Committed) -> asyncio.Event:
    """The new quote's submission holds the request's lock right after inserting the quote."""
    hold = Hold(committed, asyncio.Event())
    add = QuoteRepository.add

    async def holding(self: QuoteRepository, quote: Quote) -> Quote:
        stored = await add(self, quote)
        await hold.after(self._session, quote.request_id)
        return stored

    monkeypatch.setattr(QuoteRepository, "add", holding)
    return hold.held


async def after(event: asyncio.Event, work: Callable[[], Awaitable[None]]) -> None:
    """Starts `work` once the other side holds the request's lock."""
    await event.wait()
    await work()


async def test_concurrent_runs_transition_once(
    committed: Committed, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    # The first run holds the request's lock, its quote expired, until the second waits on it.
    held = hold_sweep(monkeypatch, committed)
    run = {"session_factory": committed.sessions}

    with caplog.at_level(logging.INFO):
        await asyncio.gather(expire_quotes(run), after(held, lambda: expire_quotes(run)))

    async with committed.sessions() as check:
        assert await status_of(check, committed.request_id) is RequestStatus.FINDING_PRO
        assert await statuses(check, committed.request_id) == {
            committed.due_quote_id: QuoteStatus.EXPIRED
        }
    assert changes_of(caplog, committed.request_id) == [("quote_ready", "finding_pro")]
    assert expired_logged(caplog, committed.request_id) == [str(committed.due_quote_id)]
    assert not [r for r in caplog.records if r.message == "quote_expiry_failed"]
    assert len([r for r in caplog.records if r.message == "quotes_expired"]) == 2


@pytest.mark.parametrize("first", ["sweep", "quote"])
async def test_quote_submitted_during_the_run_is_not_lost(
    committed: Committed,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    first: str,
) -> None:
    # Whichever takes the request's lock first holds it until the other waits on it.
    data = QuoteCreate.model_validate(body())

    async def submit() -> None:
        async with committed.sessions() as session:
            service = QuoteService(session, RecordingQueue(), ENQUEUE_TIMEOUT)
            await service.submit(committed.pro, committed.dispatch_id, data)

    async def run() -> None:
        await expire_quotes({"session_factory": committed.sessions})

    with caplog.at_level(logging.INFO):
        if first == "sweep":
            await asyncio.gather(run(), after(hold_sweep(monkeypatch, committed), submit))
        else:
            await asyncio.gather(submit(), after(hold_quote(monkeypatch, committed), run))

    async with committed.sessions() as check:
        quotes = await statuses(check, committed.request_id)
        assert quotes.pop(committed.due_quote_id) is QuoteStatus.EXPIRED
        assert list(quotes.values()) == [QuoteStatus.PENDING]  # the new quote, live
        assert await status_of(check, committed.request_id) is RequestStatus.QUOTE_READY
    # The sweep first: it backs the request out, and the new quote brings it back.
    expected = [("quote_ready", "finding_pro"), ("finding_pro", "quote_ready")]
    assert changes_of(caplog, committed.request_id) == (expected if first == "sweep" else [])
    assert not [r for r in caplog.records if r.message == "quote_expiry_failed"]
