"""RequestStateMachine: the transition table, errors, logs and locking (#160). Real database."""

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass

import pytest
from sqlalchemy import URL, delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.errors import AppError
from app.modules.addresses.models import Address
from app.modules.jobs.service import SYSTEM, SystemActor
from app.modules.requests.customer_status import REQUEST_CUSTOMER_STATUS
from app.modules.requests.errors import InvalidTransitionError
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.requests.state_machine import RequestStateMachine
from app.modules.requests.transitions import TERMINAL_STATES, TRANSITIONS
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole, UserStatus
from app.observability import JsonFormatter
from tests.conftest import backend_pid, wait_until_blocked

# Hand-written from docs/glossary.md and #160 on purpose: a change to transitions.py must show
# up as a diff here. (from, to) -> the actor kinds allowed; every other pair is a 409.
_BEFORE_ACCEPTANCE = ("received", "reviewing", "finding_pro", "quote_ready")
EXPECTED_ALLOWED: dict[tuple[str, str], set[str]] = {
    # #48: an uncategorized request goes to reviewing on its own.
    ("received", "reviewing"): {"system", "staff"},
    ("received", "finding_pro"): {"system", "staff"},
    ("reviewing", "finding_pro"): {"system", "staff"},
    ("finding_pro", "quote_ready"): {"system"},
    ("quote_ready", "accepted"): {"customer"},
    ("finding_pro", "expired"): {"system"},
    ("quote_ready", "expired"): {"system"},
    **{(src, "cancelled"): {"customer", "staff"} for src in _BEFORE_ACCEPTANCE},
}
EXPECTED_TERMINAL = {"accepted", "expired", "cancelled"}
# Who acts for each kind: the request's own customer, both staff roles, the workers.
ACTORS_OF_KIND = {"customer": ["customer"], "staff": ["agent", "admin"], "system": ["system"]}
KIND_ACTORS = ["customer", "agent", "admin", "system"]
STATES = [status.value for status in RequestStatus]

ALLOWED = [
    (src, dst, actor)
    for (src, dst), kinds in EXPECTED_ALLOWED.items()
    for kind in sorted(kinds)
    for actor in ACTORS_OF_KIND[kind]
]
WRONG_KIND = [
    (src, dst, actor)
    for (src, dst), kinds in EXPECTED_ALLOWED.items()
    for actor in KIND_ACTORS
    if not any(actor in ACTORS_OF_KIND[kind] for kind in kinds)
]
REFUSED = [
    (src, dst)
    for src in STATES
    for dst in STATES
    if src != dst and (src, dst) not in EXPECTED_ALLOWED
]


@dataclass(frozen=True)
class World:
    customer: UserAccount
    other_customer: UserAccount
    pro: UserAccount
    agent: UserAccount
    admin: UserAccount
    address_id: uuid.UUID

    def actor(self, name: str) -> UserAccount | SystemActor:
        return SYSTEM if name == "system" else getattr(self, name)


def account(user: User) -> UserAccount:
    return UserAccount(
        id=user.id, email=user.email, role=user.role, locale=user.locale, status=user.status
    )


def new_user(role: UserRole) -> User:
    email = f"{role.value}-{uuid.uuid4().hex[:8]}@x.com"
    return User(email=email, password_hash="x", role=role, status=UserStatus.ACTIVE)


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    customer, other_customer = new_user(UserRole.CUSTOMER), new_user(UserRole.CUSTOMER)
    pro, agent, admin = new_user(UserRole.PRO), new_user(UserRole.AGENT), new_user(UserRole.ADMIN)
    db_session.add_all([customer, other_customer, pro, agent, admin])
    await db_session.flush()
    address = Address(
        user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
    )
    db_session.add(address)
    await db_session.flush()
    return World(
        customer=account(customer),
        other_customer=account(other_customer),
        pro=account(pro),
        agent=account(agent),
        admin=account(admin),
        address_id=address.id,
    )


async def make_request(
    session: AsyncSession, customer_id: uuid.UUID, address_id: uuid.UUID, status: RequestStatus
) -> ServiceRequest:
    # Tests may set any status directly; app code may not (test_request_status_single_writer).
    request = ServiceRequest(
        customer_id=customer_id,
        address_id=address_id,
        description="probe-description Paint one bedroom",
        origin=RequestOrigin.APP,
        status=status,
    )
    session.add(request)
    await session.flush()
    return request


async def status_of(session: AsyncSession, request_id: uuid.UUID) -> RequestStatus:
    statement = (
        select(ServiceRequest.status)
        .where(ServiceRequest.id == request_id)
        .execution_options(populate_existing=True)
    )
    return (await session.scalars(statement)).one()


async def attempt(
    session: AsyncSession,
    request_id: uuid.UUID,
    to: str,
    actor: UserAccount | SystemActor,
) -> int:
    """200, or the AppError's status code, inside a savepoint like a failed request."""
    savepoint = await session.begin_nested()
    try:
        await RequestStateMachine(session).transition(request_id, RequestStatus(to), actor)
    except AppError as error:
        await savepoint.rollback()
        return error.status_code
    await savepoint.commit()
    return 200


# The table


def test_table_is_the_glossarys() -> None:
    table = {(s.value, d.value): {k.value for k in kinds} for (s, d), kinds in TRANSITIONS.items()}

    assert table == EXPECTED_ALLOWED
    assert {status.value for status in TERMINAL_STATES} == EXPECTED_TERMINAL


def test_every_status_is_mapped_and_in_the_table() -> None:
    in_table = {status for edge in TRANSITIONS for status in edge}

    assert set(REQUEST_CUSTOMER_STATUS) == set(RequestStatus)
    assert in_table == set(RequestStatus)


@pytest.mark.parametrize(
    ("src", "dst", "actor"), ALLOWED, ids=[f"{s}->{d}-{a}" for s, d, a in ALLOWED]
)
async def test_every_allowed_edge_succeeds_for_each_allowed_actor(
    db_session: AsyncSession, world: World, src: str, dst: str, actor: str
) -> None:
    request = await make_request(
        db_session, world.customer.id, world.address_id, RequestStatus(src)
    )

    new_status = await RequestStateMachine(db_session).transition(
        request.id, RequestStatus(dst), world.actor(actor)
    )

    assert new_status is RequestStatus(dst)
    assert await status_of(db_session, request.id) is RequestStatus(dst)


@pytest.mark.parametrize(("src", "dst"), REFUSED, ids=[f"{s}->{d}" for s, d in REFUSED])
async def test_every_other_pair_is_409_and_unchanged(
    db_session: AsyncSession, world: World, src: str, dst: str
) -> None:
    request = await make_request(
        db_session, world.customer.id, world.address_id, RequestStatus(src)
    )

    for actor in KIND_ACTORS:
        assert await attempt(db_session, request.id, dst, world.actor(actor)) == 409, actor
    assert await status_of(db_session, request.id) is RequestStatus(src)


@pytest.mark.parametrize("status", STATES)
async def test_same_status_is_409(db_session: AsyncSession, world: World, status: str) -> None:
    request = await make_request(
        db_session, world.customer.id, world.address_id, RequestStatus(status)
    )

    assert await attempt(db_session, request.id, status, world.admin) == 409


@pytest.mark.parametrize(
    ("src", "dst", "actor"), WRONG_KIND, ids=[f"{s}->{d}-{a}" for s, d, a in WRONG_KIND]
)
async def test_wrong_actor_kind_is_403_and_unchanged(
    db_session: AsyncSession, world: World, src: str, dst: str, actor: str
) -> None:
    request = await make_request(
        db_session, world.customer.id, world.address_id, RequestStatus(src)
    )

    assert await attempt(db_session, request.id, dst, world.actor(actor)) == 403
    assert await status_of(db_session, request.id) is RequestStatus(src)


async def test_other_customer_is_404_before_409(db_session: AsyncSession, world: World) -> None:
    open_request = await make_request(
        db_session, world.customer.id, world.address_id, RequestStatus.QUOTE_READY
    )
    closed = await make_request(
        db_session, world.customer.id, world.address_id, RequestStatus.CANCELLED
    )

    # An allowed edge, a terminal status and an unknown id all answer the same 404.
    assert await attempt(db_session, open_request.id, "accepted", world.other_customer) == 404
    assert await attempt(db_session, closed.id, "received", world.other_customer) == 404
    assert await attempt(db_session, uuid.uuid4(), "cancelled", world.customer) == 404
    assert await attempt(db_session, uuid.uuid4(), "cancelled", SYSTEM) == 404
    assert await status_of(db_session, open_request.id) is RequestStatus.QUOTE_READY


@pytest.mark.parametrize(
    ("src", "dst"),
    [("quote_ready", "accepted"), ("received", "cancelled"), ("expired", "received")],
)
async def test_pro_actor_is_403(db_session: AsyncSession, world: World, src: str, dst: str) -> None:
    request = await make_request(
        db_session, world.customer.id, world.address_id, RequestStatus(src)
    )

    assert await attempt(db_session, request.id, dst, world.pro) == 403
    assert await status_of(db_session, request.id) is RequestStatus(src)


@pytest.mark.parametrize("terminal", sorted(EXPECTED_TERMINAL))
async def test_terminal_states_have_no_exit(
    db_session: AsyncSession, world: World, terminal: str
) -> None:
    request = await make_request(
        db_session, world.customer.id, world.address_id, RequestStatus(terminal)
    )

    for dst in STATES:
        for actor in KIND_ACTORS:
            assert await attempt(db_session, request.id, dst, world.actor(actor)) == 409
    assert await status_of(db_session, request.id) is RequestStatus(terminal)


async def test_transition_flushes_but_does_not_commit(
    db_session: AsyncSession, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = await make_request(
        db_session, world.customer.id, world.address_id, RequestStatus.RECEIVED
    )
    request_id = request.id  # the savepoint rollback expires the object
    commits: list[AsyncSession] = []
    monkeypatch.setattr(AsyncSession, "commit", lambda self: commits.append(self))
    savepoint = await db_session.begin_nested()

    await RequestStateMachine(db_session).transition(
        request_id, RequestStatus.REVIEWING, world.agent
    )
    assert await status_of(db_session, request_id) is RequestStatus.REVIEWING  # flushed
    await savepoint.rollback()

    assert commits == []
    assert await status_of(db_session, request_id) is RequestStatus.RECEIVED


async def test_log_carries_ids_and_statuses_only(
    db_session: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    request = await make_request(
        db_session, world.customer.id, world.address_id, RequestStatus.QUOTE_READY
    )

    with caplog.at_level(logging.INFO):
        await RequestStateMachine(db_session).transition(
            request.id, RequestStatus.ACCEPTED, world.customer
        )
        await attempt(db_session, request.id, "cancelled", world.customer)  # refused: no log

    [record] = [r for r in caplog.records if r.message == "request_status_changed"]
    fields = {
        key: record.__dict__[key]
        for key in ("service_request_id", "from_status", "to_status", "actor_kind", "actor_id")
    }
    assert fields == {
        "service_request_id": str(request.id),
        "from_status": "quote_ready",
        "to_status": "accepted",
        "actor_kind": "customer",
        "actor_id": str(world.customer.id),
    }
    output = "\n".join(JsonFormatter().format(r) for r in caplog.records)
    for secret in ("probe-description", world.customer.email, "1 Main St"):
        assert secret not in output


async def test_system_actor_logs_no_actor_id(
    db_session: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    request = await make_request(
        db_session, world.customer.id, world.address_id, RequestStatus.FINDING_PRO
    )

    with caplog.at_level(logging.INFO):
        await RequestStateMachine(db_session).transition(request.id, RequestStatus.EXPIRED, SYSTEM)

    [record] = [r for r in caplog.records if r.message == "request_status_changed"]
    assert record.__dict__["actor_kind"] == "system"
    assert record.__dict__["actor_id"] is None


# Concurrency: real commits on two connections; the test deletes its rows afterwards.


@dataclass(frozen=True)
class Committed:
    sessions: async_sessionmaker[AsyncSession]
    request_id: uuid.UUID
    customer: UserAccount
    agent: UserAccount


@pytest.fixture
async def committed(test_database_url: URL) -> AsyncIterator[Committed]:
    engine = create_async_engine(test_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as session:
        customer, agent = new_user(UserRole.CUSTOMER), new_user(UserRole.AGENT)
        session.add_all([customer, agent])
        await session.flush()
        address = Address(
            user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
        )
        session.add(address)
        await session.flush()
        request = await make_request(session, customer.id, address.id, RequestStatus.RECEIVED)
        await session.commit()
        ids = (customer.id, agent.id, address.id, request.id)
        world = Committed(sessions, request.id, account(customer), account(agent))
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


async def test_concurrent_transitions_serialize(committed: Committed) -> None:
    # The customer cancels while an agent starts reviewing the same request.
    sessions = committed.sessions
    async with sessions() as first, sessions() as second:
        first_pid, second_pid = await backend_pid(first), await backend_pid(second)

        # The cancel locks the request and holds its transaction open...
        await RequestStateMachine(first).transition(
            committed.request_id, RequestStatus.CANCELLED, committed.customer
        )
        # ...while the review waits on that lock, as Postgres reports; then the cancel commits.
        review = asyncio.create_task(
            RequestStateMachine(second).transition(
                committed.request_id, RequestStatus.REVIEWING, committed.agent
            )
        )
        await wait_until_blocked(sessions, waiter=second_pid, holder=first_pid)
        await first.commit()

        # The review now reads the cancelled request: cancelled -> reviewing is not an edge.
        with pytest.raises(InvalidTransitionError):
            await review
        await second.rollback()

    async with sessions() as check:
        assert await status_of(check, committed.request_id) is RequestStatus.CANCELLED
