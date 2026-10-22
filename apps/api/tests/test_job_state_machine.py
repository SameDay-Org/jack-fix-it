"""JobStateMachine: the transition table, job_events, errors and the customer mapping (#60)."""

import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import AppError
from app.modules.addresses.models import Address
from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.jobs.service import SYSTEM, JobStateMachine, SystemActor
from app.modules.jobs.transitions import CUSTOMER_STATUS, TERMINAL_STATES
from app.modules.pros.models import ProProfile
from app.modules.pros.service import ProService
from app.modules.quotes.models import Quote
from app.modules.requests.models import RequestOrigin, ServiceRequest
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole, UserStatus

GLOSSARY = Path(__file__).resolve().parents[3] / "docs" / "glossary.md"
NOW = datetime(2026, 10, 21, 12, 0, tzinfo=UTC)

# Hand-written on purpose: a change to transitions.py must show up as a diff here.
# (from, to) -> the actor kinds allowed; every other pair is a 409.
EXPECTED_ALLOWED: dict[tuple[str, str], set[str]] = {
    ("scheduled", "on_the_way"): {"pro"},
    ("scheduled", "in_progress"): {"pro"},
    ("on_the_way", "in_progress"): {"pro"},
    ("in_progress", "completed"): {"pro"},
    ("completed", "confirmed"): {"customer", "system"},
    ("completed", "disputed"): {"customer"},
    ("confirmed", "paid_out"): {"system"},
    ("disputed", "paid_out"): {"admin"},
    ("disputed", "refunded"): {"admin"},
    ("scheduled", "cancelled"): {"customer", "pro", "admin"},
    ("on_the_way", "cancelled"): {"customer", "pro", "admin"},
}
EXPECTED_TERMINAL = {"paid_out", "refunded", "cancelled"}
EXPECTED_CUSTOMER_STATUS = {
    "scheduled": "customerStatus.scheduled",
    "on_the_way": "customerStatus.professionalOnTheWay",
    "in_progress": "customerStatus.inProgress",
    "completed": "customerStatus.waitingForConfirmation",
    "confirmed": "customerStatus.completed",
    "paid_out": "customerStatus.completed",
    "disputed": "customerStatus.needsAttention",
    "refunded": "customerStatus.cancelled",
    "cancelled": "customerStatus.cancelled",
}
# The job's own customer and pro, an admin, the system, and a BDC agent (no part in jobs).
ACTORS = ["customer", "pro", "admin", "system", "agent"]
STATES = [status.value for status in JobStatus]
MATRIX = [(src, dst, actor) for src in STATES for dst in STATES for actor in ACTORS]


def expected_outcome(src: str, dst: str, actor: str) -> int:
    allowed = EXPECTED_ALLOWED.get((src, dst))
    if allowed is None:
        return 409
    return 200 if actor in allowed else 403


@dataclass(frozen=True)
class World:
    customer: UserAccount
    other_customer: UserAccount
    pro: UserAccount
    pro_profile_id: uuid.UUID
    other_pro: UserAccount
    pro_without_profile: UserAccount
    admin: UserAccount
    agent: UserAccount
    address_id: uuid.UUID

    def actor(self, name: str) -> UserAccount | SystemActor:
        return SYSTEM if name == "system" else getattr(self, name)


def account(user: User) -> UserAccount:
    return UserAccount(
        id=user.id, email=user.email, role=user.role, locale=user.locale, status=user.status
    )


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    def user(role: UserRole) -> User:
        email = f"{role.value}-{uuid.uuid4().hex[:8]}@x.com"
        return User(email=email, password_hash="x", role=role, status=UserStatus.ACTIVE)

    customer, other_customer = user(UserRole.CUSTOMER), user(UserRole.CUSTOMER)
    pro, other_pro, bare_pro = user(UserRole.PRO), user(UserRole.PRO), user(UserRole.PRO)
    admin, agent = user(UserRole.ADMIN), user(UserRole.AGENT)
    db_session.add_all([customer, other_customer, pro, other_pro, bare_pro, admin, agent])
    await db_session.flush()
    profile, other_profile = ProProfile(user_id=pro.id), ProProfile(user_id=other_pro.id)
    address = Address(
        user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
    )
    db_session.add_all([profile, other_profile, address])
    await db_session.flush()
    return World(
        customer=account(customer),
        other_customer=account(other_customer),
        pro=account(pro),
        pro_profile_id=profile.id,
        other_pro=account(other_pro),
        pro_without_profile=account(bare_pro),
        admin=account(admin),
        agent=account(agent),
        address_id=address.id,
    )


async def make_job(session: AsyncSession, world: World, status: JobStatus, **fields: object) -> Job:
    request = ServiceRequest(
        customer_id=world.customer.id,
        address_id=world.address_id,
        description="Paint one bedroom",
        origin=RequestOrigin.APP,
    )
    session.add(request)
    await session.flush()
    quote = Quote(
        request_id=request.id,
        pro_id=world.pro_profile_id,
        amount_cents=25_000,
        scope="Walls",
        duration_minutes=240,
        proposed_start_at=NOW + timedelta(days=2),
        expires_at=NOW + timedelta(days=1),
    )
    session.add(quote)
    await session.flush()
    # Tests may set any status directly; app code may not (test_job_status_single_writer.py).
    job = Job(
        request_id=request.id,
        quote_id=quote.id,
        customer_id=world.customer.id,
        pro_id=world.pro_profile_id,
        status=status,
        customer_price_cents=25_000,
        pro_payout_cents=21_250,
        platform_fee_cents=3_750,
        tax_cents=0,
        **fields,
    )
    session.add(job)
    await session.flush()
    return job


def machine(session: AsyncSession) -> JobStateMachine:
    return JobStateMachine(session, ProService(session))


async def events_of(session: AsyncSession, job_id: uuid.UUID) -> list[JobEvent]:
    statement = select(JobEvent).where(JobEvent.job_id == job_id).order_by(JobEvent.created_at)
    return list((await session.scalars(statement)).all())


async def reload(session: AsyncSession, job: Job) -> Job:
    await session.refresh(job)
    return job


async def attempt(
    session: AsyncSession, job_id: uuid.UUID, to: JobStatus, actor: UserAccount | SystemActor
) -> int:
    """200, or the AppError's status code, inside a savepoint like a failed request."""
    savepoint = await session.begin_nested()
    try:
        await machine(session).transition(job_id, to, actor)
    except AppError as error:
        await savepoint.rollback()
        return error.status_code
    await savepoint.commit()
    return 200


# The table


@pytest.mark.parametrize(
    ("src", "dst", "actor"), MATRIX, ids=[f"{s}->{d}-{a}" for s, d, a in MATRIX]
)
async def test_exhaustive_transition_matrix(
    db_session: AsyncSession, world: World, src: str, dst: str, actor: str
) -> None:
    job = await make_job(db_session, world, JobStatus(src))
    expected = expected_outcome(src, dst, actor)

    outcome = await attempt(db_session, job.id, JobStatus(dst), world.actor(actor))

    assert outcome == expected
    job = await reload(db_session, job)
    events = await events_of(db_session, job.id)
    if expected == 200:
        assert job.status is JobStatus(dst)
        assert [(e.from_status, e.to_status) for e in events] == [(JobStatus(src), JobStatus(dst))]
    else:
        assert job.status is JobStatus(src)
        assert events == []


def test_terminal_states_are_paid_out_refunded_and_cancelled() -> None:
    assert {status.value for status in TERMINAL_STATES} == EXPECTED_TERMINAL


async def test_terminal_states_reject_everything(db_session: AsyncSession, world: World) -> None:
    for terminal in EXPECTED_TERMINAL:
        job = await make_job(db_session, world, JobStatus(terminal))
        for to in JobStatus:
            for actor in ("customer", "pro", "admin", "system"):
                assert await attempt(db_session, job.id, to, world.actor(actor)) == 409
        assert (await reload(db_session, job)).status is JobStatus(terminal)
        assert await events_of(db_session, job.id) == []


async def test_rejected_transition_writes_no_event_and_keeps_status(
    db_session: AsyncSession, world: World
) -> None:
    job = await make_job(db_session, world, JobStatus.COMPLETED)

    for to, actor, expected in [
        (JobStatus.PAID_OUT, world.actor("system"), 409),  # skips confirmed
        (JobStatus.CONFIRMED, world.actor("pro"), 403),  # the customer's call
        (JobStatus.CONFIRMED, world.actor("other_customer"), 404),
    ]:
        assert await attempt(db_session, job.id, to, actor) == expected

    job = await reload(db_session, job)
    assert job.status is JobStatus.COMPLETED
    assert job.confirmed_at is None
    assert await events_of(db_session, job.id) == []


# Events and timestamps


async def test_every_transition_writes_one_event_with_actor_and_location(
    db_session: AsyncSession, world: World
) -> None:
    job = await make_job(db_session, world, JobStatus.SCHEDULED)
    states = machine(db_session)
    where = (Decimal("28.538336"), Decimal("-81.379234"))

    await states.transition(job.id, JobStatus.ON_THE_WAY, world.pro)
    await states.transition(
        job.id, JobStatus.IN_PROGRESS, world.pro, lat=where[0], lng=where[1], event_type="check_in"
    )
    await states.transition(job.id, JobStatus.COMPLETED, world.pro)
    await states.transition(job.id, JobStatus.CONFIRMED, world.customer)
    await states.transition(job.id, JobStatus.PAID_OUT, SYSTEM)

    events = await events_of(db_session, job.id)
    assert [(e.type, e.from_status, e.to_status, e.actor_id) for e in events] == [
        ("status_changed", JobStatus.SCHEDULED, JobStatus.ON_THE_WAY, world.pro.id),
        ("check_in", JobStatus.ON_THE_WAY, JobStatus.IN_PROGRESS, world.pro.id),
        ("status_changed", JobStatus.IN_PROGRESS, JobStatus.COMPLETED, world.pro.id),
        ("status_changed", JobStatus.COMPLETED, JobStatus.CONFIRMED, world.customer.id),
        ("status_changed", JobStatus.CONFIRMED, JobStatus.PAID_OUT, None),
    ]
    assert (events[1].lat, events[1].lng) == where
    assert all((e.lat, e.lng) == (None, None) for e in events if e is not events[1])
    assert (await reload(db_session, job)).status is JobStatus.PAID_OUT


async def test_transition_returns_the_new_status_not_the_row(
    db_session: AsyncSession, world: World
) -> None:
    # #162: callers get a value, so none holds a Job whose status it could write directly.
    job = await make_job(db_session, world, JobStatus.COMPLETED)

    result = await machine(db_session).transition(job.id, JobStatus.CONFIRMED, SYSTEM)

    assert result is JobStatus.CONFIRMED
    assert not isinstance(result, Job)


async def test_system_actor_has_null_actor_id(db_session: AsyncSession, world: World) -> None:
    job = await make_job(db_session, world, JobStatus.COMPLETED)

    await machine(db_session).transition(job.id, JobStatus.CONFIRMED, SYSTEM)

    [event] = await events_of(db_session, job.id)
    assert event.actor_id is None
    assert event.to_status is JobStatus.CONFIRMED


async def test_admin_decides_a_dispute(db_session: AsyncSession, world: World) -> None:
    released = await make_job(db_session, world, JobStatus.DISPUTED)
    refunded = await make_job(db_session, world, JobStatus.DISPUTED)

    await machine(db_session).transition(released.id, JobStatus.PAID_OUT, world.admin)
    await machine(db_session).transition(refunded.id, JobStatus.REFUNDED, world.admin)

    assert (await reload(db_session, released)).status is JobStatus.PAID_OUT
    assert (await reload(db_session, refunded)).status is JobStatus.REFUNDED
    [event] = await events_of(db_session, refunded.id)
    assert event.actor_id == world.admin.id


async def test_timestamps_set_once(db_session: AsyncSession, world: World) -> None:
    job = await make_job(db_session, world, JobStatus.SCHEDULED)
    states = machine(db_session)

    await states.transition(job.id, JobStatus.ON_THE_WAY, world.pro)
    assert (job.started_at, job.completed_at, job.confirmed_at) == (None, None, None)
    await states.transition(job.id, JobStatus.IN_PROGRESS, world.pro)
    started_at = job.started_at
    assert started_at is not None
    await states.transition(job.id, JobStatus.COMPLETED, world.pro)
    completed_at = job.completed_at
    assert completed_at is not None
    await states.transition(job.id, JobStatus.CONFIRMED, world.customer)

    job = await reload(db_session, job)
    assert job.started_at == started_at
    assert job.completed_at == completed_at
    assert job.confirmed_at is not None
    assert started_at <= completed_at <= job.confirmed_at


async def test_timestamps_already_set_are_never_overwritten(
    db_session: AsyncSession, world: World
) -> None:
    earlier = NOW - timedelta(days=3)
    starting = await make_job(db_session, world, JobStatus.ON_THE_WAY, started_at=earlier)
    finishing = await make_job(db_session, world, JobStatus.IN_PROGRESS, completed_at=earlier)
    confirming = await make_job(db_session, world, JobStatus.COMPLETED, confirmed_at=earlier)
    states = machine(db_session)

    await states.transition(starting.id, JobStatus.IN_PROGRESS, world.pro)
    await states.transition(finishing.id, JobStatus.COMPLETED, world.pro)
    await states.transition(confirming.id, JobStatus.CONFIRMED, SYSTEM)

    assert (await reload(db_session, starting)).started_at == earlier
    assert (await reload(db_session, finishing)).completed_at == earlier
    assert (await reload(db_session, confirming)).confirmed_at == earlier


# Access


async def test_customer_b_cannot_confirm_customer_a_job(
    db_session: AsyncSession, world: World
) -> None:
    job = await make_job(db_session, world, JobStatus.COMPLETED)

    assert await attempt(db_session, job.id, JobStatus.CONFIRMED, world.other_customer) == 404
    # Even an edge that does not exist answers 404, not 409: nothing reveals the job's state.
    assert await attempt(db_session, job.id, JobStatus.PAID_OUT, world.other_customer) == 404
    assert (await reload(db_session, job)).status is JobStatus.COMPLETED


async def test_pro_b_cannot_start_pro_a_job(db_session: AsyncSession, world: World) -> None:
    job = await make_job(db_session, world, JobStatus.SCHEDULED)

    for stranger in (world.other_pro, world.pro_without_profile):
        assert await attempt(db_session, job.id, JobStatus.IN_PROGRESS, stranger) == 404
        assert await attempt(db_session, job.id, JobStatus.CONFIRMED, stranger) == 404
    assert (await reload(db_session, job)).status is JobStatus.SCHEDULED
    assert await events_of(db_session, job.id) == []


async def test_unknown_job_is_404(db_session: AsyncSession, world: World) -> None:
    for actor in ("customer", "pro", "admin", "system"):
        assert (
            await attempt(db_session, uuid.uuid4(), JobStatus.CONFIRMED, world.actor(actor)) == 404
        )


# Transactions


async def test_caller_owns_the_commit(db_session: AsyncSession, world: World) -> None:
    job = await make_job(db_session, world, JobStatus.COMPLETED)
    savepoint = await db_session.begin_nested()

    await machine(db_session).transition(job.id, JobStatus.CONFIRMED, world.customer)
    # transition() only flushed: rolling the caller's transaction back undoes everything.
    await savepoint.rollback()

    assert (await reload(db_session, job)).status is JobStatus.COMPLETED
    assert await events_of(db_session, job.id) == []


async def test_transition_never_commits(
    db_session: AsyncSession, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    job = await make_job(db_session, world, JobStatus.COMPLETED)

    async def forbidden_commit() -> None:
        raise AssertionError("JobStateMachine must not commit")

    monkeypatch.setattr(db_session, "commit", forbidden_commit)

    await machine(db_session).transition(job.id, JobStatus.CONFIRMED, world.customer)
    event_count = await db_session.scalar(
        select(func.count()).select_from(JobEvent).where(JobEvent.job_id == job.id)
    )
    assert event_count == 1


# Customer-visible mapping


def glossary_customer_status_keys() -> set[str]:
    text = GLOSSARY.read_text(encoding="utf-8")
    section = text.split("## Customer-visible statuses", 1)[1].split("\n## ", 1)[0]
    return set(re.findall(r"`(customerStatus\.\w+)`", section))


def test_customer_status_mapping_is_total_and_uses_glossary_keys() -> None:
    keys = glossary_customer_status_keys()

    assert len(keys) == 11
    assert {status.value: CUSTOMER_STATUS[status] for status in JobStatus} == (
        EXPECTED_CUSTOMER_STATUS
    )
    assert set(CUSTOMER_STATUS.values()) <= keys
