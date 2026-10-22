"""The database guard (#163): request and job statuses change only through the state machines,
whatever Python path issues the write. Real database, real triggers."""

import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import URL, bindparam, delete, func, select, text, update
from sqlalchemy.exc import DBAPIError, PendingRollbackError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import Base
from app.modules.addresses.models import Address
from app.modules.categories.models import Category
from app.modules.jobs.models import Job, JobStatus
from app.modules.jobs.service import JobStateMachine
from app.modules.pros.models import ProProfile
from app.modules.pros.service import ProService
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.requests.state_machine import RequestStateMachine
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole
from app.observability import JsonFormatter
from tests.helpers import FIXTURES_TOKEN, as_status_writer
from tests.test_schema_requests_jobs import add, make_job, make_quote

REFUSED = "42501"  # insufficient_privilege: the trigger's refusal
API_DIR = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Rows:
    request: ServiceRequest
    job: Job
    agent: UserAccount
    pro: UserAccount


def account(user: User) -> UserAccount:
    return UserAccount(
        id=user.id, email=user.email, role=user.role, locale=user.locale, status=user.status
    )


async def build(session: AsyncSession) -> Rows:
    """A received request and a scheduled job (both default statuses: no flag needed)."""
    tag = uuid.uuid4().hex[:8]
    customer = User(email=f"c-{tag}@x.com", password_hash="x", role=UserRole.CUSTOMER)
    agent = User(email=f"a-{tag}@x.com", password_hash="x", role=UserRole.AGENT)
    pro_user = User(email=f"p-{tag}@x.com", password_hash="x", role=UserRole.PRO)
    await add(session, customer, agent, pro_user)
    pro = ProProfile(user_id=pro_user.id)
    category = Category(slug=f"test-{tag}", names={"en": "Test", "es": "Prueba"})
    address = Address(
        user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
    )
    await add(session, pro, category, address)
    request = ServiceRequest(
        customer_id=customer.id,
        category_id=category.id,
        address_id=address.id,
        description="Paint one bedroom",
        origin=RequestOrigin.APP,
    )
    await add(session, request)
    quote = make_quote(request, pro)
    await add(session, quote)

    @dataclass(frozen=True)
    class _World:
        customer: User
        pro: ProProfile

    job = make_job(request, quote, _World(customer, pro))  # type: ignore[arg-type]  # duck-typed
    await add(session, job)
    return Rows(request, job, account(agent), account(pro_user))


@pytest.fixture
async def rows(db_session: AsyncSession) -> Rows:
    return await build(db_session)


async def refused(session: AsyncSession, write: Callable[[], Awaitable[object]]) -> DBAPIError:
    """Runs `write` in a savepoint and returns the trigger's refusal."""
    savepoint = await session.begin_nested()
    with pytest.raises(DBAPIError) as error:
        await write()
    await savepoint.rollback()
    assert getattr(error.value.orig, "sqlstate", None) == REFUSED
    return error.value


async def flag(session: AsyncSession) -> str:
    value = await session.scalar(text("SELECT current_setting('app.status_writer', true)"))
    return value or ""


# Writes outside the state machines are refused


async def test_direct_orm_status_update_refused(db_session: AsyncSession, rows: Rows) -> None:
    request_id = rows.request.id  # a savepoint rollback expires the objects

    async def request_write() -> None:
        rows.request.status = RequestStatus.ACCEPTED
        await db_session.flush()

    async def job_write() -> None:
        rows.job.status = JobStatus.PAID_OUT
        await db_session.flush()

    request_error = await refused(db_session, request_write)
    job_error = await refused(db_session, job_write)

    # The message names the table, never row data.
    assert "service_requests" in str(request_error.orig)
    assert "jobs" in str(job_error.orig)
    assert str(request_id) not in str(request_error.orig)


@pytest.mark.parametrize("model", ["requests", "jobs"])
@pytest.mark.parametrize(
    "form",
    ["core_values", "orm_bulk_params", "connection_values", "connection_parameters", "raw_sql"],
)
async def test_core_update_and_raw_sql_status_update_refused(
    db_session: AsyncSession, rows: Rows, model: str, form: str
) -> None:
    table_model: type[ServiceRequest] | type[Job]
    if model == "requests":
        table_model, row_id, status = ServiceRequest, rows.request.id, "accepted"
    else:
        table_model, row_id, status = Job, rows.job.id, "paid_out"
    table = Base.metadata.tables[table_model.__tablename__]

    async def write() -> None:
        if form == "core_values":
            await db_session.execute(
                update(table_model).where(table_model.id == row_id).values(status=status)
            )
        elif form == "orm_bulk_params":
            await db_session.execute(update(table_model), params=[{"id": row_id, "status": status}])
        elif form == "connection_values":
            connection = await db_session.connection()
            await connection.execute(
                update(table).where(table.c.id == row_id).values(status=status)
            )
        elif form == "connection_parameters":
            connection = await db_session.connection()
            await connection.execute(
                update(table).where(table.c.id == bindparam("rid")),
                parameters=[{"rid": row_id, "status": status}],
            )
        else:
            await db_session.execute(
                text(f"UPDATE {table.name} SET status = :s WHERE id = :id"),  # noqa: S608
                {"s": status, "id": row_id},
            )

    await refused(db_session, write)


async def test_insert_with_default_status_allowed(db_session: AsyncSession, rows: Rows) -> None:
    # The fixture inserted both without a status; an explicit default passes too.
    request = ServiceRequest(
        customer_id=rows.request.customer_id,
        address_id=rows.request.address_id,
        description="Fix a leak",
        origin=RequestOrigin.APP,
        status=RequestStatus.RECEIVED,
    )
    await add(db_session, request)

    assert rows.request.status is RequestStatus.RECEIVED
    assert (await db_session.scalar(select(Job.status).where(Job.id == rows.job.id))) is (
        JobStatus.SCHEDULED
    )


async def test_insert_with_other_status_refused_without_flag(
    db_session: AsyncSession, rows: Rows
) -> None:
    async def request_insert() -> None:
        await add(
            db_session,
            ServiceRequest(
                customer_id=rows.request.customer_id,
                address_id=rows.request.address_id,
                description="Fix a leak",
                origin=RequestOrigin.APP,
                status=RequestStatus.QUOTE_READY,
            ),
        )

    async def job_insert() -> None:
        other = ServiceRequest(
            customer_id=rows.request.customer_id,
            address_id=rows.request.address_id,
            description="Fix a door",
            origin=RequestOrigin.APP,
        )
        await add(db_session, other)
        await db_session.execute(
            text(
                "INSERT INTO jobs (request_id, quote_id, customer_id, pro_id, status,"
                " customer_price_cents, pro_payout_cents, platform_fee_cents, tax_cents)"
                " SELECT :rid, quote_id, customer_id, pro_id, 'completed', 1, 1, 0, 0"
                " FROM jobs WHERE id = :jid"
            ),
            {"rid": other.id, "jid": rows.job.id},
        )

    await refused(db_session, request_insert)
    await refused(db_session, job_insert)


# The state machines


async def test_state_machine_transition_succeeds_and_flag_is_cleared_after_flush(
    db_session: AsyncSession, rows: Rows
) -> None:
    await RequestStateMachine(db_session).transition(
        rows.request.id, RequestStatus.REVIEWING, rows.agent
    )
    assert await flag(db_session) == ""
    await JobStateMachine(db_session, ProService(db_session)).transition(
        rows.job.id, JobStatus.ON_THE_WAY, rows.pro
    )
    assert await flag(db_session) == ""

    statuses = (
        await db_session.scalar(
            select(ServiceRequest.status).where(ServiceRequest.id == rows.request.id)
        ),
        await db_session.scalar(select(Job.status).where(Job.id == rows.job.id)),
    )
    assert statuses == (RequestStatus.REVIEWING, JobStatus.ON_THE_WAY)

    # Later in the same transaction, nothing else may change a status.
    async def later() -> None:
        await db_session.execute(
            update(ServiceRequest)
            .where(ServiceRequest.id == rows.request.id)
            .values(status="cancelled")
        )

    await refused(db_session, later)


async def test_flag_cleared_even_when_flush_fails(
    db_session: AsyncSession, rows: Rows, monkeypatch: pytest.MonkeyPatch
) -> None:
    flush = AsyncSession.flush
    request_id = rows.request.id  # a savepoint rollback expires the objects
    seen: list[str] = []  # the token at each flush: the drain's, then the window's

    async def failing_flush(self: AsyncSession, *args: object, **kwargs: object) -> None:
        seen.append(await flag(self))
        if len(seen) == 1:
            return await flush(self)  # the drain, before the window
        raise RuntimeError("synthetic failure inside the flag's window")

    # 1. A failure that leaves the transaction usable: the flag is cleared in the finally.
    monkeypatch.setattr(AsyncSession, "flush", failing_flush)
    savepoint = await db_session.begin_nested()
    with pytest.raises(RuntimeError):
        await RequestStateMachine(db_session).transition(
            request_id, RequestStatus.REVIEWING, rows.agent
        )
    assert seen == ["", f"service_requests:{request_id}"]  # the failure was inside the window
    assert await flag(db_session) == ""
    await savepoint.rollback()

    # 2. A database failure that aborts the transaction: the flag goes with the rollback.
    async def aborting_flush(self: AsyncSession, *args: object, **kwargs: object) -> None:
        if await flag(self) == "":
            return await flush(self)  # the drain, before the window
        await self.execute(text("SELECT 1 / 0"))

    monkeypatch.setattr(AsyncSession, "flush", aborting_flush)
    savepoint = await db_session.begin_nested()
    with pytest.raises(DBAPIError):
        await RequestStateMachine(db_session).transition(
            request_id, RequestStatus.REVIEWING, rows.agent
        )
    await savepoint.rollback()
    monkeypatch.setattr(AsyncSession, "flush", flush)
    assert await flag(db_session) == ""


async def test_same_status_update_without_flag_allowed(
    db_session: AsyncSession, rows: Rows
) -> None:
    await db_session.execute(
        update(ServiceRequest)
        .where(ServiceRequest.id == rows.request.id)
        .values(status=RequestStatus.RECEIVED, next_action="call back")
    )
    await db_session.execute(
        text("UPDATE jobs SET status = status, tax_cents = 1 WHERE id = :id"), {"id": rows.job.id}
    )


async def test_other_columns_update_allowed_without_flag(
    db_session: AsyncSession, rows: Rows
) -> None:
    rows.request.next_action = "call the customer"
    rows.job.tax_cents = 2
    await db_session.flush()

    assert await db_session.scalar(
        select(ServiceRequest.next_action).where(ServiceRequest.id == rows.request.id)
    ) == ("call the customer")


async def test_triggers_and_function_exist(db_session: AsyncSession) -> None:
    triggers = set(
        (
            await db_session.scalars(
                text(
                    "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal"
                    " AND tgname LIKE '%status_%_guard'"
                )
            )
        ).all()
    )
    assert triggers == {
        "service_requests_status_update_guard",
        "service_requests_status_insert_guard",
        "jobs_status_update_guard",
        "jobs_status_insert_guard",
    }


# Pooled connections: the flag never outlives its transaction.


@dataclass(frozen=True)
class Committed:
    sessions: async_sessionmaker[AsyncSession]
    request_id: uuid.UUID
    agent: UserAccount


@pytest.fixture
async def committed(test_database_url: URL) -> AsyncIterator[Committed]:
    # hide_parameters as in production (app.db), so the log check sees what production logs.
    engine = create_async_engine(
        test_database_url, pool_size=1, max_overflow=0, hide_parameters=True
    )
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    tag = uuid.uuid4().hex[:8]
    async with sessions() as session:
        customer = User(email=f"c-{tag}@x.com", password_hash="x", role=UserRole.CUSTOMER)
        agent = User(email=f"a-{tag}@x.com", password_hash="x", role=UserRole.AGENT)
        await add(session, customer, agent)
        address = Address(
            user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
        )
        await add(session, address)
        request = ServiceRequest(
            customer_id=customer.id,
            address_id=address.id,
            description="Fix a leak",
            origin=RequestOrigin.APP,
        )
        await add(session, request)
        await session.commit()
        ids = (customer.id, agent.id, address.id, request.id)
        world = Committed(sessions, request.id, account(agent))
    try:
        yield world
    finally:
        customer_id, agent_id, address_id, request_id = ids
        async with sessions() as session:
            await session.execute(delete(ServiceRequest).where(ServiceRequest.id == request_id))
            await session.execute(delete(Address).where(Address.id == address_id))
            await session.execute(delete(User).where(User.id.in_([customer_id, agent_id])))
            await session.commit()
        await engine.dispose()


async def test_flag_does_not_leak_after_commit_or_rollback(committed: Committed) -> None:
    # One pooled connection (pool_size=1): every session below runs on the same backend.
    async def next_write_refused() -> None:
        async with committed.sessions() as session:
            await refused(
                session,
                lambda: session.execute(
                    update(ServiceRequest)
                    .where(ServiceRequest.id == committed.request_id)
                    .values(status="cancelled")
                ),
            )
            await session.rollback()

    async with committed.sessions() as session:
        await RequestStateMachine(session).transition(
            committed.request_id, RequestStatus.REVIEWING, committed.agent
        )
        await session.commit()
    await next_write_refused()

    # Even a token for this very row, left set by a transaction that ended, is gone in the next.
    token = f"service_requests:{committed.request_id}"
    for end in ("commit", "rollback"):
        async with committed.sessions() as session:
            await session.execute(
                text("SELECT set_config('app.status_writer', :token, true)"), {"token": token}
            )
            await getattr(session, end)()
        await next_write_refused()


def test_flag_appears_only_in_the_machines_and_this_migration() -> None:
    """The AST guard (test_job_status_single_writer) covers app/; this also covers scripts/ and
    alembic/. Tests set the flag through tests/helpers.py::as_status_writer."""
    found = {
        path.relative_to(API_DIR).as_posix()
        for folder in ("app", "scripts", "alembic")
        for path in (API_DIR / folder).rglob("*.py")
        if "app.status_writer" in path.read_text(encoding="utf-8")
    }

    assert found == {
        "app/modules/jobs/service.py",
        "app/modules/requests/state_machine.py",
        "alembic/versions/20261022_4eb1fd67455e_status_writer_triggers.py",
    }


async def test_refusal_reaching_the_api_is_a_500_naming_the_table_only(
    app: FastAPI, committed: Committed, caplog: pytest.LogCaptureFixture
) -> None:
    # No endpoint changes a status yet; this test-only route stands in for a buggy one.
    @app.post("/test-only/direct-status-write")
    async def direct_status_write() -> None:
        async with committed.sessions() as session:
            await session.execute(
                update(ServiceRequest)
                .where(ServiceRequest.id == committed.request_id)
                .values(status="cancelled")
            )

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    with caplog.at_level(logging.DEBUG):
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post("/test-only/direct-status-write")

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"
    [record] = [r for r in caplog.records if r.message == "unhandled_error"]
    logged = JsonFormatter().format(record)
    assert "the status of service_requests changes only through its state machine" in logged
    assert str(committed.request_id) not in logged
    assert "cancelled" not in logged


# Row-scoped tokens and the drain (#174 review round 1): a machine's window authorizes its own
# row only. Unrelated pending writes, deferred with no_autoflush (an ordinary unit-of-work
# pattern), never ride along with its flush.

PENDING_DESCRIPTION = "Pending direct insert (#174 review)"
_BAD_STATUS = {"request": RequestStatus.ACCEPTED, "job": JobStatus.PAID_OUT}
_MODEL: dict[str, type[ServiceRequest] | type[Job]] = {"request": ServiceRequest, "job": Job}


async def transition(session: AsyncSession, rows: Rows, machine: str) -> None:
    """A valid transition by one of the machines, on `rows`."""
    if machine == "request":
        await RequestStateMachine(session).transition(
            rows.request.id, RequestStatus.REVIEWING, rows.agent
        )
    else:
        await JobStateMachine(session, ProService(session)).transition(
            rows.job.id, JobStatus.ON_THE_WAY, rows.pro
        )


async def status_of(session: AsyncSession, kind: str, row_id: uuid.UUID) -> str:
    model = _MODEL[kind]
    statement = select(model.status).where(model.id == row_id)
    value = await session.scalar(statement.execution_options(populate_existing=True))
    assert value is not None
    return str(value)


@pytest.mark.parametrize("machine", ["request", "job"])
@pytest.mark.parametrize("victim_kind", ["request", "job"])
async def test_unrelated_dirty_status_is_refused_and_stays_unchanged(
    db_session: AsyncSession, machine: str, victim_kind: str
) -> None:
    authorized, victim = await build(db_session), await build(db_session)
    row = victim.request if victim_kind == "request" else victim.job
    row_id, original = row.id, str(row.status)

    savepoint = await db_session.begin_nested()

    async def ride_along() -> None:
        with db_session.no_autoflush:
            row.status = _BAD_STATUS[victim_kind]  # type: ignore[assignment]  # either model
            await transition(db_session, authorized, machine)

    with pytest.raises(DBAPIError) as error:
        await ride_along()
    await savepoint.rollback()

    assert getattr(error.value.orig, "sqlstate", None) == REFUSED
    assert await status_of(db_session, victim_kind, row_id) == original


@pytest.mark.parametrize("machine", ["request", "job"])
async def test_unrelated_nondefault_insert_is_refused_and_not_inserted(
    db_session: AsyncSession, machine: str
) -> None:
    authorized = await build(db_session)
    pending = ServiceRequest(
        customer_id=authorized.request.customer_id,
        address_id=authorized.request.address_id,
        description=PENDING_DESCRIPTION,
        origin=RequestOrigin.APP,
        status=RequestStatus.ACCEPTED,
    )

    savepoint = await db_session.begin_nested()

    async def ride_along() -> None:
        with db_session.no_autoflush:
            db_session.add(pending)
            await transition(db_session, authorized, machine)

    with pytest.raises(DBAPIError) as error:
        await ride_along()
    await savepoint.rollback()

    assert getattr(error.value.orig, "sqlstate", None) == REFUSED
    inserted = select(func.count()).where(ServiceRequest.description == PENDING_DESCRIPTION)
    assert await db_session.scalar(inserted) == 0


@pytest.mark.parametrize("machine", ["request", "job"])
async def test_a_pending_status_on_the_target_row_is_refused_not_taken_as_its_start(
    db_session: AsyncSession, rows: Rows, machine: str
) -> None:
    # The drain refuses it before the machine reads the row; without the drain the row lock
    # would reload the row and drop the pending write in silence, or start from it.
    target = rows.request if machine == "request" else rows.job
    target_id, original = target.id, str(target.status)

    savepoint = await db_session.begin_nested()

    async def ride_along() -> None:
        with db_session.no_autoflush:
            target.status = _BAD_STATUS[machine]  # type: ignore[assignment]  # either model
            await transition(db_session, rows, machine)

    with pytest.raises(DBAPIError) as error:
        await ride_along()
    await savepoint.rollback()

    assert getattr(error.value.orig, "sqlstate", None) == REFUSED
    assert await status_of(db_session, machine, target_id) == original


async def test_refused_ride_along_changes_nothing_even_if_the_caller_commits(
    committed: Committed,
) -> None:
    async with committed.sessions() as session:
        request = await session.get(ServiceRequest, committed.request_id)
        assert request is not None
        victim = ServiceRequest(
            customer_id=request.customer_id,
            address_id=request.address_id,
            description="Ride-along victim (#174 review)",
            origin=RequestOrigin.APP,
        )
        await add(session, victim)
        await session.commit()
        victim_id = victim.id
    try:
        async with committed.sessions() as session:
            victim_row = await session.get(ServiceRequest, victim_id)
            assert victim_row is not None

            async def ride_along() -> None:
                with session.no_autoflush:
                    victim_row.status = RequestStatus.ACCEPTED
                    await RequestStateMachine(session).transition(
                        committed.request_id, RequestStatus.REVIEWING, committed.agent
                    )

            with pytest.raises(DBAPIError):
                await ride_along()
            # A caller that swallows the error and commits: the failed transaction cannot.
            with pytest.raises((PendingRollbackError, DBAPIError)):
                await session.commit()
            await session.rollback()

        async with committed.sessions() as reader:
            statuses = {
                row_id: await reader.scalar(
                    select(ServiceRequest.status).where(ServiceRequest.id == row_id)
                )
                for row_id in (victim_id, committed.request_id)
            }
        assert statuses == {
            victim_id: RequestStatus.RECEIVED,
            committed.request_id: RequestStatus.RECEIVED,
        }
    finally:
        async with committed.sessions() as session:
            await session.execute(delete(ServiceRequest).where(ServiceRequest.id == victim_id))
            await session.commit()


async def test_a_row_token_authorizes_that_row_only(db_session: AsyncSession) -> None:
    mine, other = await build(db_session), await build(db_session)
    token = f"service_requests:{mine.request.id}"
    await db_session.execute(
        text("SELECT set_config('app.status_writer', :token, true)"), {"token": token}
    )

    def set_status(
        model: type[ServiceRequest] | type[Job], row_id: uuid.UUID
    ) -> Callable[[], Awaitable[object]]:
        statement = update(model).where(model.id == row_id).values(status="cancelled")
        return lambda: db_session.execute(statement)

    await refused(db_session, set_status(ServiceRequest, other.request.id))
    await refused(db_session, set_status(Job, mine.job.id))
    await set_status(ServiceRequest, mine.request.id)()

    assert await status_of(db_session, "request", mine.request.id) == RequestStatus.CANCELLED


async def test_the_old_plain_flag_authorizes_nothing(db_session: AsyncSession, rows: Rows) -> None:
    await db_session.execute(text("SELECT set_config('app.status_writer', 'state_machine', true)"))

    await refused(
        db_session,
        lambda: db_session.execute(
            update(ServiceRequest)
            .where(ServiceRequest.id == rows.request.id)
            .values(status="cancelled")
        ),
    )


async def test_the_fixtures_token_works_only_in_the_test_database(
    db_session: AsyncSession, rows: Rows
) -> None:
    write = (
        update(ServiceRequest).where(ServiceRequest.id == rows.request.id).values(status="expired")
    )

    async def with_fixtures_token() -> None:
        async with as_status_writer(db_session):
            await db_session.execute(write)

    # A database without the setting (any production one) refuses the wildcard.
    await db_session.execute(text("SELECT set_config('app.status_writer_fixtures', 'off', true)"))
    await refused(db_session, with_fixtures_token)
    # The test database has it (conftest), and the wildcard then works.
    await db_session.execute(text("SELECT set_config('app.status_writer_fixtures', 'on', true)"))
    await with_fixtures_token()
    assert await status_of(db_session, "request", rows.request.id) == RequestStatus.EXPIRED


def test_the_machines_never_use_the_fixtures_token() -> None:
    for machine in ("app/modules/jobs/service.py", "app/modules/requests/state_machine.py"):
        source = (API_DIR / machine).read_text(encoding="utf-8")
        assert "status_writer_fixtures" not in source, machine
        assert f'"{FIXTURES_TOKEN}"' not in source, machine
        assert f"'{FIXTURES_TOKEN}'" not in source, machine
