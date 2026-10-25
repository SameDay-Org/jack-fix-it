"""POST /v1/pros/me/opportunities/{dispatch_id}/quote: fixed-price quotes (D9.3, #50)."""

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from redis.exceptions import RedisError
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import get_storage
from app.modules.dispatch.models import DispatchStatus
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.quotes.repository import QuoteRepository
from app.modules.quotes.schemas import QuoteCreate
from app.modules.quotes.service import QuoteService
from app.modules.requests.models import RequestStatus, ServiceRequest
from app.modules.requests.state_machine import RequestStateMachine
from app.modules.settings.models import Setting
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole
from app.observability import JsonFormatter
from app.queue import get_job_queue
from tests.conftest import make_settings
from tests.test_dispatch import record_commits
from tests.test_opportunities_api import (
    NOT_FOUND,
    Pro,
    World,
    build_world,
    dispatch,
    dispatch_row,
    make_request,
)
from tests.test_requests_api import ENQUEUE_TIMEOUT, FakeStorage, RecordingQueue, make_caller

TTL_HOURS = 36  # not the seeded 48, so the tests prove the value is read


@pytest.fixture
def settings() -> Settings:
    # A short enqueue bound, so a hung Redis ends the new quote push quickly.
    return make_settings(job_enqueue_timeout_seconds=ENQUEUE_TIMEOUT)


@pytest.fixture(autouse=True)
def queue(app: FastAPI) -> RecordingQueue:
    """The new quote push's queue (#55): recorded, never Redis."""
    recorder = RecordingQueue()
    app.dependency_overrides[get_job_queue] = lambda: recorder
    return recorder


@pytest.fixture
def storage(app: FastAPI) -> FakeStorage:
    fake = FakeStorage()
    app.dependency_overrides[get_storage] = lambda: fake
    return fake


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    return await build_world(db_session)


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
    """The quote TTL, a fixture value, in the rolled-back test session."""
    await set_setting(db_session, "quote_ttl_hours", TTL_HOURS)


async def quote(
    client: httpx.AsyncClient, pro: Pro, dispatch_id: uuid.UUID, **overrides: Any
) -> httpx.Response:
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
        select(Quote)
        .where(Quote.request_id == request_id)
        .execution_options(populate_existing=True)
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


@pytest.mark.parametrize("amount", [0, -5, 1.5, "100", True, None, 2**31], ids=repr)
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
    too_long = await quote(
        db_client, world.me, over_duration, amount_cents=500, duration_minutes=481
    )
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


CAPS = ["quote_max_amount_cents", "quote_max_duration_minutes"]
INT4_MAX = 2_147_483_647
# Present but malformed: never read as "no cap" (Vault round 1: the first three let 2^31-1 in).
MALFORMED_CAPS = ["98765", 0, True, -98765, INT4_MAX + 1, 98765.5, None, [98765], {"cap": 98765}]
MALFORMED_IDS = [
    "string",
    "zero",
    "true",
    "negative",
    "above_int4",
    "float",
    "null",
    "list",
    "object",
]


@pytest.mark.parametrize("stored", MALFORMED_CAPS, ids=MALFORMED_IDS)
@pytest.mark.parametrize("key", CAPS)
async def test_an_invalid_cap_503_and_nothing_written(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
    key: str,
    stored: object,
) -> None:
    await set_setting(db_session, key, stored)
    request_id = await make_request(db_session, world)
    dispatch_id = await dispatch(db_session, request_id, world.me)

    with caplog.at_level(logging.DEBUG):
        response = await quote(
            db_client, world.me, dispatch_id, amount_cents=INT4_MAX, duration_minutes=INT4_MAX
        )

    assert response.status_code == 503
    assert response.json() == {
        "error": {"code": "not_configured", "message": "This feature is not configured yet."}
    }
    assert await quotes_of(db_session, request_id) == []
    assert (await dispatch_row(db_session, dispatch_id)).status is DispatchStatus.SENT
    assert await status_of(db_session, request_id) is RequestStatus.FINDING_PRO
    [invalid] = [r for r in caplog.records if r.message == "setting_invalid"]
    [refused] = [r for r in caplog.records if r.message == "quote_not_configured"]
    assert invalid.__dict__["key"] == refused.__dict__["key"] == key
    output = "\n".join(JsonFormatter().format(r) for r in caplog.records)
    assert "98765" not in output
    assert str(INT4_MAX + 1) not in output
    assert '"value"' not in output


@pytest.mark.parametrize("amount", [1, INT4_MAX])
async def test_absent_caps_accept_any_int4(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    amount: int,
) -> None:
    await db_session.execute(delete(Setting).where(Setting.key.in_(CAPS)))
    request_id = await make_request(db_session, world)
    dispatch_id = await dispatch(db_session, request_id, world.me)

    response = await quote(
        db_client, world.me, dispatch_id, amount_cents=amount, duration_minutes=INT4_MAX
    )

    assert response.status_code == 201
    [stored] = await quotes_of(db_session, request_id)
    assert (stored.amount_cents, stored.duration_minutes) == (amount, INT4_MAX)


@pytest.mark.parametrize(
    ("key", "field"),
    [
        ("quote_max_amount_cents", "amount_cents"),
        ("quote_max_duration_minutes", "duration_minutes"),
    ],
)
@pytest.mark.parametrize("cap", [1, 10_000, INT4_MAX - 1])
async def test_a_valid_cap_is_the_highest_value_accepted(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    key: str,
    field: str,
    cap: int,
) -> None:
    await set_setting(db_session, key, cap)
    over = await dispatch(db_session, await make_request(db_session, world), world.me)
    at = await dispatch(db_session, await make_request(db_session, world), world.me)

    rejected = await quote(db_client, world.me, over, **{field: cap + 1})
    accepted = await quote(db_client, world.me, at, **{field: cap})

    assert (rejected.status_code, accepted.status_code) == (422, 201)


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
        await QuoteService(db_session, RecordingQueue(), ENQUEUE_TIMEOUT).submit(
            actor, dispatch_id, data
        )
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


# New quote push (D10.4, #55)


async def public_code_of(session: AsyncSession, request_id: uuid.UUID) -> str:
    code = await session.scalar(
        select(ServiceRequest.public_code).where(ServiceRequest.id == request_id)
    )
    assert code is not None
    return code


async def test_quote_enqueues_push_to_customer_after_commit(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    queue: RecordingQueue,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request_id = await make_request(db_session, world)
    dispatch_id = await dispatch(db_session, request_id, world.me)
    code = await public_code_of(db_session, request_id)
    record_commits(monkeypatch)

    response = await quote(db_client, world.me, dispatch_id)
    again = await quote(db_client, world.me, dispatch_id)

    assert response.status_code == 201
    quote_id = response.json()["id"]
    assert queue.jobs == {
        f"push:quote:{quote_id}": (
            "send_push",
            (
                str(world.customer_id),
                f"quote:{quote_id}",
                "push.new_quote.title",
                "push.new_quote.body",
                {"public_code": code},
                f"/requests/{request_id}",
            ),
        )
    }
    assert queue.before == ["commit"]  # queued after the quote's commit, once
    # A refused quote (409 quote_exists) commits nothing and announces nothing.
    assert again.status_code == 409
    assert len(queue.before) == 1


@pytest.mark.parametrize(
    "broken",
    [RecordingQueue(failure=RedisError("down")), RecordingQueue(hang=True)],
    ids=["redis_error", "timeout"],
)
async def test_enqueue_failure_or_timeout_does_not_fail_quote(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    broken: RecordingQueue,
    caplog: pytest.LogCaptureFixture,
) -> None:
    app.dependency_overrides[get_job_queue] = lambda: broken
    request_id = await make_request(db_session, world)
    dispatch_id = await dispatch(db_session, request_id, world.me)
    code = await public_code_of(db_session, request_id)

    with caplog.at_level(logging.DEBUG):
        response = await asyncio.wait_for(quote(db_client, world.me, dispatch_id), timeout=5)

    assert response.status_code == 201
    assert len(await quotes_of(db_session, request_id)) == 1
    assert await status_of(db_session, request_id) is RequestStatus.QUOTE_READY
    assert (await dispatch_row(db_session, dispatch_id)).status is DispatchStatus.QUOTED
    # Logged with ids only: the customer and the message (the event's kind and id).
    [record] = [r for r in caplog.records if r.message == "push_enqueue_failed"]
    payload = json.loads(JsonFormatter().format(record))
    assert set(payload) - {"timestamp", "level", "logger", "message", "request_id"} == {
        "user_id",
        "message_id",
    }
    assert payload["user_id"] == str(world.customer_id)
    assert payload["message_id"] == f"quote:{response.json()['id']}"
    output = "\n".join(JsonFormatter().format(r) for r in caplog.records)
    for secret in (code, "probe-scope-text", str(AMOUNT)):
        assert secret not in output
