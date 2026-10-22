"""POST /v1/pros/me/opportunities/{dispatch_id}/quote: fixed-price quotes (D9.3, #50)."""

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import URL, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.addresses.models import Address
from app.modules.categories.models import Category
from app.modules.dispatch.models import DispatchStatus, RequestDispatch
from app.modules.pros.models import ProProfile
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.quotes.repository import QuoteRepository
from app.modules.quotes.schemas import QuoteCreate
from app.modules.quotes.service import QuoteService
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.requests.state_machine import RequestStateMachine
from app.modules.settings.models import Setting
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole
from app.observability import JsonFormatter
from tests.conftest import backend_pid, wait_until_blocked
from tests.test_opportunities_api import (
    NOT_FOUND,
    Pro,
    World,
    dispatch,
    dispatch_row,
    make_request,
    settings,  # noqa: F401 - the opportunities' settings fixture, reused here
    storage,  # noqa: F401 - the opportunities' storage fixture, reused here
    world,  # noqa: F401 - the opportunities' world fixture, reused here
)
from tests.test_requests_api import FakeStorage, make_caller

TTL_HOURS = 36  # a fixture value: X is Cesar's to pick (#50)
SCOPE = "Replace the kitchen faucet, probe-scope-text"
AMOUNT = 98_765


def path(dispatch_id: uuid.UUID) -> str:
    return f"/v1/pros/me/opportunities/{dispatch_id}/quote"


def body(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "amount_cents": AMOUNT,
        "scope": f"  {SCOPE}  ",
        "duration_minutes": 90,
        "proposed_start_at": (datetime.now(UTC) + timedelta(days=2)).isoformat(),
    }
    values.update(overrides)
    return values


async def set_setting(session: AsyncSession, key: str, value: object) -> None:
    await session.execute(delete(Setting).where(Setting.key == key))
    session.add(Setting(key=key, value=value))
    await session.flush()


@pytest.fixture(autouse=True)
async def quote_ttl(db_session: AsyncSession) -> None:
    await set_setting(db_session, "quote_ttl_hours", TTL_HOURS)


async def quote(client: httpx.AsyncClient, pro: Pro, dispatch_id: uuid.UUID, **overrides: Any) -> httpx.Response:
    return await client.post(path(dispatch_id), json=body(**overrides), headers=pro.caller.headers)


async def status_of(session: AsyncSession, request_id: uuid.UUID) -> RequestStatus:
    statement = (
        select(ServiceRequest.status)
        .where(ServiceRequest.id == request_id)
        .execution_options(populate_existing=True)
    )
    return (await session.scalars(statement)).one()


async def quotes_of(session: AsyncSession, request_id: uuid.UUID) -> list[Quote]:
    statement = (
        select(Quote).where(Quote.request_id == request_id).execution_options(populate_existing=True)
    )
    return list((await session.scalars(statement)).all())


# Submitting


async def test_dispatched_pro_quotes_201_and_request_moves_to_quote_ready(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, storage: FakeStorage
) -> None:
    request_id = await make_request(db_session, world)
    dispatch_id = await dispatch(db_session, request_id, world.me)

    response = await quote(db_client, world.me, dispatch_id)

    assert response.status_code == 201
    out = response.json()
    assert set(out) == {
        "id",
        "amount_cents",
        "scope",
        "duration_minutes",
        "proposed_start_at",
        "expires_at",
        "status",
        "created_at",
    }
    assert (out["amount_cents"], out["scope"], out["duration_minutes"]) == (AMOUNT, SCOPE, 90)
    assert out["status"] == "pending"
    [stored] = await quotes_of(db_session, request_id)
    assert (stored.pro_id, stored.amount_cents, stored.status) == (
        world.me.profile_id,
        AMOUNT,
        QuoteStatus.PENDING,
    )
    assert await status_of(db_session, request_id) is RequestStatus.QUOTE_READY


async def test_second_quote_on_quote_ready_request_does_not_transition(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
) -> None:
    request_id = await make_request(db_session, world)
    mine = await dispatch(db_session, request_id, world.me)
    theirs = await dispatch(db_session, request_id, world.other)

    with caplog.at_level(logging.INFO):
        first = await quote(db_client, world.me, mine)
        second = await quote(db_client, world.other, theirs)

    assert (first.status_code, second.status_code) == (201, 201)
    assert len(await quotes_of(db_session, request_id)) == 2
    assert await status_of(db_session, request_id) is RequestStatus.QUOTE_READY
    changes = [r for r in caplog.records if r.message == "request_status_changed"]
    assert [(r.__dict__["from_status"], r.__dict__["to_status"]) for r in changes] == [
        ("finding_pro", "quote_ready")
    ]


async def test_dispatch_marked_quoted_with_responded_at(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, storage: FakeStorage
) -> None:
    dispatch_id = await dispatch(db_session, await make_request(db_session, world), world.me)

    before = datetime.now(UTC)
    assert (await quote(db_client, world.me, dispatch_id)).status_code == 201

    row = await dispatch_row(db_session, dispatch_id)
    assert row.status is DispatchStatus.QUOTED
    assert row.responded_at is not None
    assert before - timedelta(seconds=1) <= row.responded_at <= datetime.now(UTC)


# Who may quote


async def test_foreign_or_unknown_dispatch_404_same_body_as_49(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, storage: FakeStorage
) -> None:
    request_id = await make_request(db_session, world)
    theirs = await dispatch(db_session, request_id, world.other)

    for dispatch_id in (theirs, uuid.uuid4()):
        response = await quote(db_client, world.me, dispatch_id)
        assert response.status_code == 404
        assert response.json() == NOT_FOUND
    assert await quotes_of(db_session, request_id) == []
    assert (await dispatch_row(db_session, theirs)).status is DispatchStatus.SENT


async def test_declined_or_closed_dispatch_409_not_quotable(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, storage: FakeStorage
) -> None:
    cases = [
        await dispatch(db_session, await make_request(db_session, world), world.me, status=status)
        for status in (DispatchStatus.DECLINED, DispatchStatus.EXPIRED)
    ] + [
        await dispatch(db_session, await make_request(db_session, world, closed), world.me)
        for closed in (RequestStatus.ACCEPTED, RequestStatus.EXPIRED, RequestStatus.CANCELLED)
    ]

    for dispatch_id in cases:
        response = await quote(db_client, world.me, dispatch_id)
        assert response.status_code == 409, dispatch_id
        assert response.json()["error"]["code"] == "not_quotable"
    assert await db_session.scalar(select(func.count()).select_from(Quote)) == 0


async def test_duplicate_quote_409_quote_exists(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request_id = await make_request(db_session, world)
    dispatch_id = await dispatch(db_session, request_id, world.me)
    assert (await quote(db_client, world.me, dispatch_id)).status_code == 201

    again = await quote(db_client, world.me, dispatch_id)

    assert again.status_code == 409
    assert again.json()["error"]["code"] == "quote_exists"

    # The unique constraint is the backstop: past a check that missed, still a 409, never a 500.
    other_request = await make_request(db_session, world)
    raced = await dispatch(db_session, other_request, world.me, status=DispatchStatus.VIEWED)
    db_session.add(
        Quote(
            request_id=other_request,
            pro_id=world.me.profile_id,
            amount_cents=1,
            scope="x",
            duration_minutes=1,
            proposed_start_at=datetime.now(UTC) + timedelta(days=1),
            expires_at=datetime.now(UTC) + timedelta(days=1),
        )
    )
    await db_session.flush()

    async def missed(self: QuoteRepository, request_id: uuid.UUID, pro_id: uuid.UUID) -> bool:
        return False

    monkeypatch.setattr(QuoteRepository, "exists_for", missed)
    backstop = await quote(db_client, world.me, raced)
    assert backstop.status_code == 409
    assert backstop.json()["error"]["code"] == "quote_exists"
    assert (await dispatch_row(db_session, raced)).status is DispatchStatus.VIEWED


# The body


@pytest.mark.parametrize(
    "amount", [0, -5, 1.5, "100", True, None, 2**31], ids=repr
)
async def test_amount_must_be_positive_int_and_within_cap(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    amount: object,
) -> None:
    dispatch_id = await dispatch(db_session, await make_request(db_session, world), world.me)

    response = await quote(db_client, world.me, dispatch_id, amount_cents=amount)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


async def test_caps_from_settings(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, storage: FakeStorage
) -> None:
    await set_setting(db_session, "quote_max_amount_cents", 10_000)
    await set_setting(db_session, "quote_max_duration_minutes", 480)
    over_amount = await dispatch(db_session, await make_request(db_session, world), world.me)
    over_duration = await dispatch(db_session, await make_request(db_session, world), world.me)
    at_caps = await dispatch(db_session, await make_request(db_session, world), world.me)

    too_much = await quote(db_client, world.me, over_amount, amount_cents=10_001)
    too_long = await quote(db_client, world.me, over_duration, amount_cents=500, duration_minutes=481)
    exact = await quote(db_client, world.me, at_caps, amount_cents=10_000, duration_minutes=480)

    assert (too_much.status_code, too_long.status_code, exact.status_code) == (422, 422, 201)
    assert too_much.json()["error"]["code"] == "validation_error"


@pytest.mark.parametrize(
    "start",
    [
        (datetime.now(UTC) - timedelta(minutes=1)).isoformat(),
        (datetime.now(UTC) + timedelta(days=1)).replace(tzinfo=None).isoformat(),
        "tomorrow",
    ],
    ids=["past", "no_time_zone", "not_a_time"],
)
async def test_proposed_start_must_be_future(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    start: str,
) -> None:
    dispatch_id = await dispatch(db_session, await make_request(db_session, world), world.me)

    response = await quote(db_client, world.me, dispatch_id, proposed_start_at=start)

    assert response.status_code == 422


@pytest.mark.parametrize(
    "extra",
    [
        {"status": "accepted"},
        {"expires_at": "2099-01-01T00:00:00Z"},
        {"pro_id": str(uuid.uuid4())},
        {"request_id": str(uuid.uuid4())},
    ],
    ids=["status", "expires_at", "pro_id", "request_id"],
)
async def test_client_cannot_set_status_or_expiry_422(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    extra: dict[str, str],
) -> None:
    dispatch_id = await dispatch(db_session, await make_request(db_session, world), world.me)

    response = await quote(db_client, world.me, dispatch_id, **extra)

    assert response.status_code == 422
    assert (await dispatch_row(db_session, dispatch_id)).status is DispatchStatus.SENT


@pytest.mark.parametrize("scope", ["   ", "x" * 2001, "a\x00b"], ids=["blank", "too_long", "nul"])
async def test_scope_trimmed_and_bounded(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    scope: str,
) -> None:
    dispatch_id = await dispatch(db_session, await make_request(db_session, world), world.me)

    assert (await quote(db_client, world.me, dispatch_id, scope=scope)).status_code == 422


# The lifetime


async def test_expires_at_from_settings(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, storage: FakeStorage
) -> None:
    dispatch_id = await dispatch(db_session, await make_request(db_session, world), world.me)

    before = datetime.now(UTC)
    out = (await quote(db_client, world.me, dispatch_id)).json()
    after = datetime.now(UTC)

    expires_at = datetime.fromisoformat(out["expires_at"])
    assert before + timedelta(hours=TTL_HOURS) <= expires_at <= after + timedelta(hours=TTL_HOURS)


@pytest.mark.parametrize("stored", [None, "36", 0, True], ids=["missing", "string", "zero", "bool"])
async def test_missing_ttl_setting_503_and_nothing_written(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
    stored: object,
) -> None:
    await db_session.execute(delete(Setting).where(Setting.key == "quote_ttl_hours"))
    if stored is not None:
        await set_setting(db_session, "quote_ttl_hours", stored)
    request_id = await make_request(db_session, world)
    dispatch_id = await dispatch(db_session, request_id, world.me)

    with caplog.at_level(logging.WARNING):
        response = await quote(db_client, world.me, dispatch_id)

    assert response.status_code == 503
    assert response.json() == {
        "error": {"code": "not_configured", "message": "This feature is not configured yet."}
    }
    assert await quotes_of(db_session, request_id) == []
    assert (await dispatch_row(db_session, dispatch_id)).status is DispatchStatus.SENT
    assert await status_of(db_session, request_id) is RequestStatus.FINDING_PRO
    [invalid] = [r for r in caplog.records if r.message == "setting_invalid"]
    assert invalid.__dict__["key"] == "quote_ttl_hours"


# Access


@pytest.mark.parametrize("role", [UserRole.CUSTOMER, UserRole.AGENT, UserRole.ADMIN])
async def test_customer_agent_admin_403(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    role: UserRole,
) -> None:
    caller = await make_caller(db_session, role)
    dispatch_id = await dispatch(db_session, await make_request(db_session, world), world.me)

    response = await db_client.post(path(dispatch_id), json=body(), headers=caller.headers)

    assert response.status_code == 403
    assert (await db_client.post(path(dispatch_id), json=body())).status_code == 401


# One transaction


async def test_all_writes_roll_back_together(
    db_session: AsyncSession, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    request_id = await make_request(db_session, world)
    dispatch_id = await dispatch(db_session, request_id, world.me)
    pro = await db_session.get(User, world.me.caller.id)
    assert pro is not None
    actor = UserAccount(
        id=pro.id, email=pro.email, role=pro.role, locale=pro.locale, status=pro.status
    )

    async def fail(*args: object, **kwargs: object) -> RequestStatus:
        raise RuntimeError("synthetic failure after the insert and the dispatch update")

    monkeypatch.setattr(RequestStateMachine, "transition", fail)
    savepoint = await db_session.begin_nested()  # the request's transaction
    data = QuoteCreate.model_validate(body())
    with pytest.raises(RuntimeError):
        await QuoteService(db_session).submit(actor, dispatch_id, data)
    await savepoint.rollback()

    assert await quotes_of(db_session, request_id) == []
    assert (await dispatch_row(db_session, dispatch_id)).status is DispatchStatus.SENT
    assert await status_of(db_session, request_id) is RequestStatus.FINDING_PRO


async def test_logs_never_carry_scope(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
) -> None:
    request_id = await make_request(db_session, world)
    dispatch_id = await dispatch(db_session, request_id, world.me)

    with caplog.at_level(logging.DEBUG):
        response = await quote(db_client, world.me, dispatch_id)

    output = "\n".join(JsonFormatter().format(r) for r in caplog.records)
    assert "probe-scope-text" not in output
    assert str(AMOUNT) not in output
    [submitted] = [r for r in caplog.records if r.message == "quote_submitted"]
    assert submitted.__dict__["quote_id"] == response.json()["id"]
    assert submitted.__dict__["dispatch_id"] == str(dispatch_id)
    assert submitted.__dict__["service_request_id"] == str(request_id)
    assert submitted.__dict__["first_quote"] is True


def test_openapi_documents_the_route_and_errors(app: Any) -> None:
    operation = app.openapi()["paths"]["/v1/pros/me/opportunities/{dispatch_id}/quote"]["post"]

    assert {"201", "401", "403", "404", "409", "422", "503"} <= set(operation["responses"])
    assert "quote_exists" in operation["responses"]["409"]["description"]
    assert "not_configured" in operation["responses"]["503"]["description"]


# Concurrency: real commits on two connections; the test deletes its rows afterwards.


@dataclass(frozen=True)
class Committed:
    sessions: async_sessionmaker[AsyncSession]
    request_id: uuid.UUID
    pros: list[tuple[UserAccount, uuid.UUID, uuid.UUID]]  # (account, profile id, dispatch id)


@pytest.fixture
async def committed(test_database_url: URL) -> AsyncIterator[Committed]:
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
            status=RequestStatus.FINDING_PRO,
        )
        session.add(request)
        await session.flush()
        dispatches = [
            RequestDispatch(request_id=request.id, pro_id=profile.id, sent_at=datetime.now(UTC))
            for profile in profiles
        ]
        session.add_all(dispatches)
        await session.execute(delete(Setting).where(Setting.key == "quote_ttl_hours"))
        session.add(Setting(key="quote_ttl_hours", value=TTL_HOURS))
        await session.commit()
        pros = [
            (
                UserAccount(
                    id=user.id, email=user.email, role=user.role, locale=user.locale, status=user.status
                ),
                profile.id,
                row.id,
            )
            for user, profile, row in zip(pro_users, profiles, dispatches, strict=True)
        ]
    try:
        yield Committed(sessions, request.id, pros)
    finally:
        async with sessions() as session:
            await session.execute(delete(Quote).where(Quote.request_id == request.id))
            await session.execute(delete(RequestDispatch).where(RequestDispatch.request_id == request.id))
            await session.execute(delete(ServiceRequest).where(ServiceRequest.id == request.id))
            await session.execute(delete(Address).where(Address.id == address.id))
            await session.execute(delete(ProProfile).where(ProProfile.id.in_([p.id for p in profiles])))
            await session.execute(
                delete(User).where(User.id.in_([customer.id, *[u.id for u in pro_users]]))
            )
            await session.execute(delete(Category).where(Category.id == category.id))
            await session.execute(delete(Setting).where(Setting.key == "quote_ttl_hours"))
            await session.commit()
        await engine.dispose()


async def test_concurrent_first_quotes_from_two_pros_transition_once(
    committed: Committed, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    sessions = committed.sessions
    async with sessions() as first, sessions() as second:
        first_pid, second_pid = await backend_pid(first), await backend_pid(second)
        add = QuoteRepository.add

        async def add_then_hold(self: QuoteRepository, row: Quote) -> Quote:
            stored = await add(self, row)
            if self._session is first:
                # The first quote holds the request lock until the second waits on it.
                await wait_until_blocked(sessions, waiter=second_pid, holder=first_pid)
            return stored

        monkeypatch.setattr(QuoteRepository, "add", add_then_hold)
        data = QuoteCreate.model_validate(body())
        (pro_a, _, dispatch_a), (pro_b, _, dispatch_b) = committed.pros

        with caplog.at_level(logging.INFO):
            first_task = asyncio.create_task(QuoteService(first).submit(pro_a, dispatch_a, data))
            # Let the first take the lock before the second starts.
            while not any(r.message == "dispatch_marked" for r in caplog.records) and not first_task.done():
                await asyncio.sleep(0)
                if await _locked(sessions, first_pid):
                    break
            second_task = asyncio.create_task(QuoteService(second).submit(pro_b, dispatch_b, data))
            results = await asyncio.gather(first_task, second_task)

    assert all(result.status is QuoteStatus.PENDING for result in results)
    async with sessions() as check:
        assert len(await quotes_of(check, committed.request_id)) == 2
        assert await status_of(check, committed.request_id) is RequestStatus.QUOTE_READY
    changes = [r for r in caplog.records if r.message == "request_status_changed"]
    assert len(changes) == 1


async def _locked(sessions: async_sessionmaker[AsyncSession], pid: int) -> bool:
    """True once backend `pid` holds a row lock (it has the request locked)."""
    from sqlalchemy import text

    async with sessions() as monitor:
        held = await monitor.scalar(
            text(
                "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = :pid AND locktype = 'transactionid'"
                " AND granted)"
            ),
            {"pid": pid},
        )
    return bool(held)
