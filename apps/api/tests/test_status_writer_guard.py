"""The database guard (#163): request and job statuses change only through the state machines,
whatever Python path issues the write. Real database, real triggers."""

import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass

import pytest
from sqlalchemy import URL, bindparam, delete, select, text, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

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
from tests.test_schema_requests_jobs import add, make_job, make_quote

REFUSED = "42501"  # insufficient_privilege: the trigger's refusal


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
    assert str(rows.request.id) not in str(request_error.orig)


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
    table = table_model.__table__

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

    async def failing_flush(self: AsyncSession, *args: object, **kwargs: object) -> None:
        raise RuntimeError("synthetic failure inside the flag's window")

    # 1. A failure that leaves the transaction usable: the flag is cleared in the finally.
    monkeypatch.setattr(AsyncSession, "flush", failing_flush)
    savepoint = await db_session.begin_nested()
    with pytest.raises(RuntimeError):
        await RequestStateMachine(db_session).transition(
            rows.request.id, RequestStatus.REVIEWING, rows.agent
        )
    assert await flag(db_session) == ""
    await savepoint.rollback()

    # 2. A database failure that aborts the transaction: the flag goes with the rollback.
    async def aborting_flush(self: AsyncSession, *args: object, **kwargs: object) -> None:
        await self.execute(text("SELECT 1 / 0"))

    monkeypatch.setattr(AsyncSession, "flush", aborting_flush)
    savepoint = await db_session.begin_nested()
    with pytest.raises(DBAPIError):
        await RequestStateMachine(db_session).transition(
            rows.request.id, RequestStatus.REVIEWING, rows.agent
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
    engine = create_async_engine(test_database_url, pool_size=1, max_overflow=0)
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

    # Even a flag left set by a transaction that ended is gone in the next one.
    for end in ("commit", "rollback"):
        async with committed.sessions() as session:
            await session.execute(
                text("SELECT set_config('app.status_writer', 'state_machine', true)")
            )
            await getattr(session, end)()
        await next_write_refused()
