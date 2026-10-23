"""Dispatch (D9.1, #48): eligibility, ranking, N, the move to finding_pro, re-runs. Real DB."""

import asyncio
import logging
import secrets
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from arq.worker import Function
from sqlalchemy import URL, delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.addresses.models import Address
from app.modules.categories.models import Category
from app.modules.dispatch.models import RequestDispatch
from app.modules.dispatch.repository import ProHistory
from app.modules.dispatch.service import DispatchOutcome, DispatchService, rank
from app.modules.dispatch.tasks import dispatch_request
from app.modules.pros.models import ProCategory, ProProfile, ProServiceArea, ProVerificationStatus
from app.modules.pros.service import DispatchCandidate
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.service_areas.models import ServiceArea
from app.modules.settings.models import Setting
from app.modules.users.models import User
from app.modules.users.types import UserRole, UserStatus
from app.observability import JsonFormatter
from app.worker import WorkerSettings
from tests.conftest import backend_pid, wait_until_blocked
from tests.helpers import as_status_writer

NOW = datetime.now(UTC)


def free_zips(count: int) -> list[str]:
    """Distinct five-digit ZIPs for fixture service areas (their ZIPs are unique)."""
    return [f"9{n:04d}" for n in secrets.SystemRandom().sample(range(10_000), count)]


@dataclass(frozen=True)
class World:
    category_id: uuid.UUID
    other_category_id: uuid.UUID
    area_id: uuid.UUID
    inactive_area_id: uuid.UUID
    other_area_id: uuid.UUID
    zip_code: str
    inactive_zip: str
    customer_id: uuid.UUID
    address_id: uuid.UUID


async def build_world(session: AsyncSession) -> World:
    tag = uuid.uuid4().hex[:8]
    category = Category(slug=f"test-{tag}", names={"en": "Test", "es": "Prueba"})
    other = Category(slug=f"other-{tag}", names={"en": "Other", "es": "Otra"})
    zip_code, inactive_zip, other_zip = free_zips(3)

    def area(zip_code: str, active: bool = True) -> ServiceArea:
        return ServiceArea(
            region="Test", city="Orlando", state="FL", zip_code=zip_code, active=active
        )

    areas = [area(zip_code), area(inactive_zip, active=False), area(other_zip)]
    customer = User(email=f"c-{tag}@x.com", password_hash="x", role=UserRole.CUSTOMER)
    session.add_all([category, other, *areas, customer])
    await session.flush()
    # ZIP+4 on the address: dispatch matches on its five digits.
    address = Address(
        user_id=customer.id,
        line1="1 Main St",
        city="Orlando",
        state="FL",
        zip_code=f"{zip_code}-1234",
    )
    session.add(address)
    await session.flush()
    return World(
        category_id=category.id,
        other_category_id=other.id,
        area_id=areas[0].id,
        inactive_area_id=areas[1].id,
        other_area_id=areas[2].id,
        zip_code=zip_code,
        inactive_zip=inactive_zip,
        customer_id=customer.id,
        address_id=address.id,
    )


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    return await build_world(db_session)


async def make_pro(
    session: AsyncSession,
    world: World,
    *,
    verification: ProVerificationStatus = ProVerificationStatus.APPROVED,
    payouts: bool = True,
    role: UserRole = UserRole.PRO,
    status: UserStatus = UserStatus.ACTIVE,
    category: str = "category",
    area: str = "area",
    rating: str | None = None,
) -> uuid.UUID:
    user = User(
        email=f"p-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=role, status=status
    )
    session.add(user)
    await session.flush()
    profile = ProProfile(
        user_id=user.id,
        verification_status=verification,
        payouts_enabled=payouts,
        rating_avg=Decimal(rating) if rating is not None else None,
    )
    session.add(profile)
    await session.flush()
    category_id = world.category_id if category == "category" else world.other_category_id
    area_id = {
        "area": world.area_id,
        "inactive": world.inactive_area_id,
        "other": world.other_area_id,
    }[area]
    session.add_all(
        [
            ProCategory(pro_id=profile.id, category_id=category_id),
            ProServiceArea(pro_id=profile.id, service_area_id=area_id),
        ]
    )
    await session.flush()
    return profile.id


async def make_request(
    session: AsyncSession,
    world: World,
    *,
    status: RequestStatus = RequestStatus.RECEIVED,
    categorized: bool = True,
) -> uuid.UUID:
    # Tests may set any status directly; app code may not (test_request_status_single_writer).
    request = ServiceRequest(
        customer_id=world.customer_id,
        address_id=world.address_id,
        category_id=world.category_id if categorized else None,
        description="probe-description Fix a leak",
        origin=RequestOrigin.APP,
        status=status,
    )
    async with as_status_writer(session):  # the database guard (#163)
        session.add(request)
        await session.flush()
    return request.id


async def set_max_pros(session: AsyncSession, value: int) -> None:
    await session.execute(
        update(Setting).where(Setting.key == "dispatch_max_pros").values(value=value)
    )


async def dispatched_to(session: AsyncSession, request_id: uuid.UUID) -> set[uuid.UUID]:
    statement = select(RequestDispatch.pro_id).where(RequestDispatch.request_id == request_id)
    return set((await session.scalars(statement)).all())


async def status_of(session: AsyncSession, request_id: uuid.UUID) -> RequestStatus:
    statement = (
        select(ServiceRequest.status)
        .where(ServiceRequest.id == request_id)
        .execution_options(populate_existing=True)
    )
    return (await session.scalars(statement)).one()


# Eligibility


async def test_eligible_requires_approved_payouts_active_category_and_active_zip(
    db_session: AsyncSession, world: World
) -> None:
    eligible = await make_pro(db_session, world)
    for not_eligible in (
        {"verification": ProVerificationStatus.PENDING},
        {"verification": ProVerificationStatus.REJECTED},
        {"payouts": False},
        {"status": UserStatus.SUSPENDED},
        {"role": UserRole.CUSTOMER},  # a profile on an account that is not a pro's
        {"category": "other"},
        {"area": "inactive"},
        {"area": "other"},
    ):
        await make_pro(db_session, world, **not_eligible)
    await set_max_pros(db_session, 50)
    request_id = await make_request(db_session, world)

    outcome = await DispatchService(db_session).dispatch_request(request_id)

    assert outcome is DispatchOutcome.SENT
    assert await dispatched_to(db_session, request_id) == {eligible}


async def test_a_request_in_an_inactive_area_goes_to_nobody(
    db_session: AsyncSession, world: World
) -> None:
    # The area of the request's own ZIP is switched off: its pros get nothing.
    await make_pro(db_session, world, area="inactive")
    address = Address(
        user_id=world.customer_id,
        line1="2 Main St",
        city="Orlando",
        state="FL",
        zip_code=world.inactive_zip,
    )
    db_session.add(address)
    await db_session.flush()
    request_id = await make_request(db_session, replace(world, address_id=address.id))

    outcome = await DispatchService(db_session).dispatch_request(request_id)

    assert outcome is DispatchOutcome.NO_ELIGIBLE_PROS
    assert await dispatched_to(db_session, request_id) == set()


# Ranking


def candidate(name: int, rating: str | None = None) -> DispatchCandidate:
    return DispatchCandidate(
        pro_id=uuid.UUID(int=name),
        user_id=uuid.uuid4(),
        rating_avg=Decimal(rating) if rating is not None else None,
    )


def test_ranked_by_rating_then_response_time_then_tiebreak() -> None:
    week_ago, yesterday = NOW - timedelta(days=7), NOW - timedelta(days=1)
    candidates = [
        candidate(1),  # unrated, never dispatched
        candidate(2),  # unrated, dispatched yesterday, never answered
        candidate(3),  # unrated, dispatched a week ago, never answered
        candidate(4, "4.50"),  # slow
        candidate(5, "4.50"),  # fast
        candidate(6, "4.50"),  # no answers yet
        candidate(7, "4.90"),
        candidate(8),  # unrated, answers in a minute
        candidate(10),  # unrated, never dispatched: the id breaks the tie with 1
    ]
    history = {
        uuid.UUID(int=2): ProHistory(avg_response_seconds=None, last_sent_at=yesterday),
        uuid.UUID(int=3): ProHistory(avg_response_seconds=None, last_sent_at=week_ago),
        uuid.UUID(int=4): ProHistory(avg_response_seconds=3_600.0, last_sent_at=yesterday),
        uuid.UUID(int=5): ProHistory(avg_response_seconds=60.0, last_sent_at=yesterday),
        uuid.UUID(int=6): ProHistory(avg_response_seconds=None, last_sent_at=yesterday),
        uuid.UUID(int=8): ProHistory(avg_response_seconds=60.0, last_sent_at=yesterday),
    }

    ranked = rank(list(reversed(candidates)), history)

    assert [pro.int for pro in ranked] == [7, 5, 4, 6, 8, 1, 10, 3, 2]


async def test_ranking_reads_the_dispatch_history(db_session: AsyncSession, world: World) -> None:
    fast, slow, recent, fresh, rated = [await make_pro(db_session, world) for _ in range(5)]
    await db_session.execute(
        update(ProProfile).where(ProProfile.id == rated).values(rating_avg=Decimal("4.00"))
    )
    # Past requests, answered fast and slow, and one sent yesterday with no answer yet.
    for pro_id, answered_after in ((fast, 60), (slow, 6_000), (recent, None)):
        past = await make_request(db_session, world, status=RequestStatus.FINDING_PRO)
        sent_at = NOW - timedelta(days=1)
        db_session.add(
            RequestDispatch(
                request_id=past,
                pro_id=pro_id,
                sent_at=sent_at,
                responded_at=sent_at + timedelta(seconds=answered_after)
                if answered_after is not None
                else None,
            )
        )
    await db_session.flush()
    await set_max_pros(db_session, 4)
    request_id = await make_request(db_session, world)

    await DispatchService(db_session).dispatch_request(request_id)

    # Rated first, then the fast and the slow answerers, then the one never sent a request.
    assert await dispatched_to(db_session, request_id) == {rated, fast, slow, fresh}


async def test_caps_at_n_from_settings(db_session: AsyncSession, world: World) -> None:
    best, second, _ = [
        await make_pro(db_session, world, rating=rating) for rating in ("4.90", "4.80", "4.70")
    ]
    await set_max_pros(db_session, 2)
    request_id = await make_request(db_session, world)

    await DispatchService(db_session).dispatch_request(request_id)

    assert await dispatched_to(db_session, request_id) == {best, second}


# The move to finding_pro


async def test_moves_to_finding_pro_in_same_transaction_as_rows(
    db_session: AsyncSession, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    pro = await make_pro(db_session, world)
    request_id = await make_request(db_session, world, status=RequestStatus.REVIEWING)

    savepoint = await db_session.begin_nested()
    assert await DispatchService(db_session).dispatch_request(request_id) is DispatchOutcome.SENT
    assert await dispatched_to(db_session, request_id) == {pro}
    assert await status_of(db_session, request_id) is RequestStatus.FINDING_PRO
    await savepoint.rollback()  # the caller's transaction fails: both go
    assert await dispatched_to(db_session, request_id) == set()
    assert await status_of(db_session, request_id) is RequestStatus.REVIEWING

    # And when the transition itself fails, the caller's rollback takes the rows with it.
    from app.modules.requests.state_machine import RequestStateMachine

    async def refuse(*args: object, **kwargs: object) -> RequestStatus:
        raise RuntimeError("synthetic transition failure")

    monkeypatch.setattr(RequestStateMachine, "transition", refuse)
    savepoint = await db_session.begin_nested()
    with pytest.raises(RuntimeError):
        await DispatchService(db_session).dispatch_request(request_id)
    await savepoint.rollback()
    assert await dispatched_to(db_session, request_id) == set()


async def test_uncategorized_goes_to_reviewing_without_dispatch(
    db_session: AsyncSession, world: World
) -> None:
    await make_pro(db_session, world)
    request_id = await make_request(db_session, world, categorized=False)

    outcome = await DispatchService(db_session).dispatch_request(request_id)

    assert outcome is DispatchOutcome.TO_REVIEW
    assert await status_of(db_session, request_id) is RequestStatus.REVIEWING
    assert await dispatched_to(db_session, request_id) == set()
    # Still uncategorized in reviewing: the BDC classifies it first, nothing happens.
    assert (
        await DispatchService(db_session).dispatch_request(request_id)
        is DispatchOutcome.NOT_DISPATCHABLE
    )


async def test_no_eligible_pros_leaves_status_and_logs(
    db_session: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    await make_pro(db_session, world, payouts=False)
    request_id = await make_request(db_session, world)

    with caplog.at_level(logging.INFO):
        outcome = await DispatchService(db_session).dispatch_request(request_id)

    assert outcome is DispatchOutcome.NO_ELIGIBLE_PROS
    assert await status_of(db_session, request_id) is RequestStatus.RECEIVED
    assert await dispatched_to(db_session, request_id) == set()
    [record] = [r for r in caplog.records if r.message == "dispatch_no_eligible_pros"]
    assert record.__dict__["service_request_id"] == str(request_id)
    assert record.__dict__["category_id"] == str(world.category_id)


@pytest.mark.parametrize(
    "status",
    [
        RequestStatus.FINDING_PRO,
        RequestStatus.QUOTE_READY,
        RequestStatus.ACCEPTED,
        RequestStatus.EXPIRED,
        RequestStatus.CANCELLED,
    ],
)
async def test_non_dispatchable_status_is_noop(
    db_session: AsyncSession, world: World, status: RequestStatus
) -> None:
    await make_pro(db_session, world)
    request_id = await make_request(db_session, world, status=status)

    outcome = await DispatchService(db_session).dispatch_request(request_id)

    assert outcome is DispatchOutcome.NOT_DISPATCHABLE
    assert await status_of(db_session, request_id) is status
    assert await dispatched_to(db_session, request_id) == set()


async def test_unknown_request_is_noop(db_session: AsyncSession) -> None:
    outcome = await DispatchService(db_session).dispatch_request(uuid.uuid4())

    assert outcome is DispatchOutcome.UNKNOWN_REQUEST


async def test_logs_carry_ids_only(
    db_session: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    await make_pro(db_session, world)
    request_id = await make_request(db_session, world)

    with caplog.at_level(logging.DEBUG):
        await DispatchService(db_session).dispatch_request(request_id)

    output = "\n".join(JsonFormatter().format(r) for r in caplog.records)
    for secret in ("probe-description", "1 Main St", world.zip_code, "@x.com"):
        assert secret not in output
    [done] = [r for r in caplog.records if r.message == "dispatch_done"]
    assert done.__dict__["outcome"] == "sent"
    assert done.__dict__["count"] == 1


# Re-runs


async def test_rerun_is_noop(db_session: AsyncSession, world: World) -> None:
    pro = await make_pro(db_session, world)
    request_id = await make_request(db_session, world)

    first = await DispatchService(db_session).dispatch_request(request_id)
    await make_pro(db_session, world)  # a new eligible pro appears
    second = await DispatchService(db_session).dispatch_request(request_id)

    assert (first, second) == (DispatchOutcome.SENT, DispatchOutcome.ALREADY_DISPATCHED)
    assert await dispatched_to(db_session, request_id) == {pro}


@dataclass(frozen=True)
class Committed:
    sessions: async_sessionmaker[AsyncSession]
    request_id: uuid.UUID
    pro_ids: list[uuid.UUID]


@pytest.fixture
async def committed(test_database_url: URL) -> AsyncIterator[Committed]:
    """A request and two eligible pros, committed; deleted afterwards."""
    engine = create_async_engine(test_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as session:
        world = await build_world(session)
        pros = [await make_pro(session, world) for _ in range(2)]
        request_id = await make_request(session, world)
        await session.commit()
    try:
        yield Committed(sessions, request_id, pros)
    finally:
        async with sessions() as session:
            user_ids = select(ProProfile.user_id).where(ProProfile.id.in_(pros))
            await session.execute(
                delete(RequestDispatch).where(RequestDispatch.request_id == request_id)
            )
            await session.execute(delete(ServiceRequest).where(ServiceRequest.id == request_id))
            await session.execute(delete(Address).where(Address.id == world.address_id))
            await session.execute(delete(ProCategory).where(ProCategory.pro_id.in_(pros)))
            await session.execute(delete(ProServiceArea).where(ProServiceArea.pro_id.in_(pros)))
            pro_users = list((await session.scalars(user_ids)).all())
            await session.execute(delete(ProProfile).where(ProProfile.id.in_(pros)))
            await session.execute(delete(User).where(User.id.in_([*pro_users, world.customer_id])))
            areas = [world.area_id, world.inactive_area_id, world.other_area_id]
            await session.execute(delete(ServiceArea).where(ServiceArea.id.in_(areas)))
            await session.execute(
                delete(Category).where(
                    Category.id.in_([world.category_id, world.other_category_id])
                )
            )
            await session.commit()
        await engine.dispose()


async def test_concurrent_runs_insert_once(committed: Committed) -> None:
    sessions = committed.sessions
    async with sessions() as first, sessions() as second:
        first_pid, second_pid = await backend_pid(first), await backend_pid(second)

        # The first run locks the request and holds its transaction open...
        assert (
            await DispatchService(first).dispatch_request(committed.request_id)
            is DispatchOutcome.SENT
        )
        # ...while the second waits on that lock, as Postgres reports; then the first commits.
        rerun = asyncio.create_task(DispatchService(second).dispatch_request(committed.request_id))
        await wait_until_blocked(sessions, waiter=second_pid, holder=first_pid)
        await first.commit()

        assert await rerun is DispatchOutcome.ALREADY_DISPATCHED
        await second.commit()

    async with sessions() as check:
        count = await check.scalar(
            select(func.count())
            .select_from(RequestDispatch)
            .where(RequestDispatch.request_id == committed.request_id)
        )
        assert count == len(committed.pro_ids)
        assert await status_of(check, committed.request_id) is RequestStatus.FINDING_PRO


# The worker


def sessions_of(session: AsyncSession) -> Callable[[], AbstractAsyncContextManager[AsyncSession]]:
    @asynccontextmanager
    async def factory() -> AsyncIterator[AsyncSession]:
        yield session

    return factory


async def test_the_task_dispatches_in_its_own_transaction(
    db_session: AsyncSession, world: World
) -> None:
    pro = await make_pro(db_session, world)
    request_id = await make_request(db_session, world)

    outcome = await dispatch_request({"session_factory": sessions_of(db_session)}, str(request_id))

    assert outcome == "sent"
    assert await dispatched_to(db_session, request_id) == {pro}


def test_worker_registers_the_task() -> None:
    coroutines = [f.coroutine for f in WorkerSettings.functions if isinstance(f, Function)]
    assert dispatch_request in coroutines
