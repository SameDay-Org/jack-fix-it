"""Requests made on the web without an account (#86): POST /v1/web/requests, from the web
service only. A served ZIP makes one received web request for a guest customer, with its
staff-only contact and UTM, never dispatched; an unserved one joins the waitlist. Replays,
the honeypot, the body cap, the limits, the BDC card, and the guest's exclusions. On the
rolled-back test session, but the race (real commits, at the end)."""

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.integrations.storage import get_storage
from app.modules.addresses.models import Address
from app.modules.auth.security import hash_password
from app.modules.dispatch.service import AssignRefusal, DispatchOutcome, DispatchService
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.requests.service import undispatched_requests
from app.modules.service_areas.models import ServiceArea
from app.modules.users.models import User
from app.modules.users.types import UserRole, UserStatus
from app.modules.waitlist.models import WaitlistEntry
from app.modules.web_requests.models import WebRequestContact
from app.queue import get_job_queue
from app.rate_limit import IdentifierHasher, get_rate_limiter
from tests.conftest import (
    TEST_WEB_SERVICE_SETTINGS,
    Committed,
    InMemoryRateLimiter,
    make_settings,
)
from tests.test_interest_api import VISITOR, RecordingLimiter, web
from tests.test_me_card_fields import FakeStorage
from tests.test_requests_api import ADDRESS, DESCRIPTION, RecordingQueue, make_caller, make_category

PATH: Final = "/v1/web/requests"
NOW: Final = datetime(2030, 3, 1, tzinfo=UTC).timestamp()
# The contact: sentinels, so a leak anywhere is found by its text.
FIRST: Final = "Harperzq"
EMAIL: Final = "sentinel.web86@example.com"
PHONE: Final = "+13055550186"
CONSENT: Final = "web-request-2026-11-20"
UTM: Final = {"source": "google", "campaign": "launch-86"}
UNSERVED: Final = {**ADDRESS, "zip_code": "99501"}


@pytest.fixture
def settings() -> Settings:
    # Room for a test's few creates with one contact; the limits have their own test.
    return make_settings(
        **TEST_WEB_SERVICE_SETTINGS, web_request_email_limit=50, web_request_phone_limit=50
    )


@pytest.fixture(autouse=True)
def queue(app: FastAPI) -> RecordingQueue:
    recorder = RecordingQueue()
    app.dependency_overrides[get_job_queue] = lambda: recorder
    app.dependency_overrides[get_storage] = lambda: FakeStorage()
    limiter = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    return recorder


@pytest.fixture
async def served(db_session: AsyncSession) -> None:
    db_session.add(
        ServiceArea(region="Web", city="Orlando", state="FL", zip_code=ADDRESS["zip_code"])
    )
    await db_session.flush()


def body(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "description": DESCRIPTION,
        "address": dict(ADDRESS),
        "contact": {"first_name": FIRST, "email": EMAIL, "phone": PHONE},
        "consent_version": CONSENT,
        "utm": dict(UTM),
    }
    return values | overrides


async def send(
    client: httpx.AsyncClient,
    data: dict[str, Any] | None = None,
    *,
    key: str | None = None,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    sent = {**(web() if headers is None else headers), "Idempotency-Key": key or str(uuid.uuid4())}
    return await client.post(PATH, json=body() if data is None else data, headers=sent)


async def count(session: AsyncSession, model: type[Any]) -> int:
    return (await session.execute(select(func.count()).select_from(model))).scalar_one()


async def web_requests(session: AsyncSession) -> list[ServiceRequest]:
    statement = select(ServiceRequest).where(ServiceRequest.origin == RequestOrigin.WEB)
    return list((await session.scalars(statement.execution_options(populate_existing=True))).all())


async def guests(session: AsyncSession) -> list[User]:
    statement = select(User).where(User.status == UserStatus.GUEST)
    return list((await session.scalars(statement)).all())


# --- A served ZIP: one received web request for a guest ------------------------------------


async def test_a_served_zip_makes_one_received_request_for_a_guest_with_its_contact(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None, queue: RecordingQueue
) -> None:
    answer = await send(db_client)

    assert answer.status_code == 201, answer.text
    [request] = await web_requests(db_session)
    assert answer.json() == {"public_code": request.public_code, "status": "received"}
    assert (request.status, request.utm, request.language) == (
        RequestStatus.RECEIVED,
        UTM,
        "en",
    )
    [guest] = await guests(db_session)
    assert request.customer_id == guest.id
    assert guest.email.endswith("@guest.invalid")
    assert EMAIL not in guest.email
    assert (guest.role, guest.first_name, guest.phone) == (UserRole.CUSTOMER, None, None)
    contact = await db_session.get(WebRequestContact, request.id)
    assert contact is not None
    assert (contact.first_name, contact.email, contact.phone, contact.consent_version) == (
        FIRST,
        EMAIL,
        PHONE,
        CONSENT,
    )
    # Never dispatched: no dispatch task, before or after the commit.
    assert all("dispatch" not in str(job) for job in queue.jobs.values())


async def test_a_replay_answers_the_same_code_and_another_body_is_refused(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    key = str(uuid.uuid4())
    first = await send(db_client, key=key)
    again = await send(db_client, key=key)
    other = await send(db_client, body(description="Another job entirely"), key=key)

    assert (first.status_code, again.status_code) == (201, 201)
    assert again.json() == first.json()
    assert (other.status_code, other.json()["error"]["code"]) == (409, "idempotency_key_reused")
    assert len(await web_requests(db_session)) == 1
    assert len(await guests(db_session)) == 1


async def test_the_honeypot_answers_alike_and_stores_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    answer = await send(db_client, body(website="https://spam.example"))

    assert answer.status_code == 201, answer.text
    assert answer.json()["status"] == "received"
    assert answer.json()["public_code"].startswith("JF-")
    assert (await web_requests(db_session), await guests(db_session)) == ([], [])
    assert await count(db_session, WebRequestContact) == 0


async def test_an_unserved_zip_joins_the_waitlist_and_makes_no_request(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    answer = await send(db_client, body(address=UNSERVED))

    assert (answer.status_code, answer.json()["error"]["code"]) == (409, "out_of_area")
    [entry] = (await db_session.scalars(select(WaitlistEntry))).all()
    assert (entry.zip_code, entry.email, entry.phone) == ("99501", EMAIL, PHONE)
    assert (await web_requests(db_session), await guests(db_session)) == ([], [])


async def test_the_category_s_questions_are_checked_as_the_app_checks_them(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    question = {"key": "rooms", "type": "integer", "label": {"en": "Rooms"}, "required": True}
    category = await make_category(db_session, questions=[question])

    answer = await send(db_client, body(category_id=str(category), intake_answers={}))

    assert answer.status_code == 422, answer.text
    assert (await web_requests(db_session), await guests(db_session)) == ([], [])


# --- The web service only, and a body read only when it is small --------------------------


@pytest.mark.parametrize("key", [None, "not-the-web-service-key-0123456789abcdef"])
async def test_only_the_web_service_s_key_and_the_body_is_never_read_without_it(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None, key: str | None
) -> None:
    sent = {
        **web(key=key),
        "Idempotency-Key": str(uuid.uuid4()),
        "Content-Type": "application/json",
    }
    # Not even JSON: a body that was read would be a 422.
    answer = await db_client.post(PATH, content=b"{not json", headers=sent)

    assert (answer.status_code, answer.json()["error"]["code"]) == (401, "invalid_service_key")
    assert await web_requests(db_session) == []


async def test_a_body_over_the_cap_or_of_unknown_length_is_refused_unread(
    db_client: httpx.AsyncClient, settings: Settings
) -> None:
    sent = {**web(), "Idempotency-Key": str(uuid.uuid4()), "Content-Type": "application/json"}
    large = b"x" * (settings.web_request_max_body_bytes + 1)

    async def chunks() -> AsyncIterator[bytes]:
        yield b"{}"

    too_large = await db_client.post(PATH, content=large, headers=sent)
    unknown = await db_client.post(PATH, content=chunks(), headers=sent)

    assert (too_large.status_code, too_large.json()["error"]["code"]) == (413, "payload_too_large")
    assert (unknown.status_code, unknown.json()["error"]["code"]) == (411, "length_required")


async def test_the_limits_count_the_forwarded_visitor_and_the_hashed_contact(
    app: FastAPI, db_client: httpx.AsyncClient, served: None, settings: Settings
) -> None:
    limiter = RecordingLimiter()
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    hashed = IdentifierHasher.from_settings(settings)

    assert (await send(db_client)).status_code == 201

    hour, day = settings.web_request_window_seconds, settings.web_request_daily_window_seconds
    assert [(scope, identifier, window) for scope, identifier, _, window in limiter.hits] == [
        ("web_request_ip", VISITOR, hour),
        ("web_request_email", hashed(EMAIL), hour),
        ("web_request_phone", hashed(PHONE), hour),
        ("web_request_email_day", hashed(EMAIL), day),
        ("web_request_phone_day", hashed(PHONE), day),
    ]


async def test_a_refused_limit_writes_nothing(
    app: FastAPI, db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    app.dependency_overrides[get_rate_limiter] = lambda: RecordingLimiter(allowed=False)

    answer = await send(db_client)

    assert (answer.status_code, answer.json()["error"]["code"]) == (429, "rate_limited")
    assert (await web_requests(db_session), await guests(db_session)) == ([], [])


# --- The contact: the BDC's only -----------------------------------------------------------


async def test_the_contact_never_reaches_the_logs(
    db_client: httpx.AsyncClient, served: None, caplog: pytest.LogCaptureFixture
) -> None:
    key = str(uuid.uuid4())
    with caplog.at_level(logging.DEBUG):
        await send(db_client, key=key)
        await send(db_client, key=key)
        await send(db_client, body(address=UNSERVED))

    assert "web_request_created" in caplog.text
    for leak in (FIRST, EMAIL, PHONE, key, VISITOR):
        assert leak not in caplog.text


async def test_staff_read_the_contact_origin_and_utm_and_nobody_else_does(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    assert (await send(db_client)).status_code == 201
    [request] = await web_requests(db_session)
    agent = await make_caller(db_session, UserRole.AGENT)
    customer = await make_caller(db_session)
    pro = await make_caller(db_session, UserRole.PRO)

    card = await db_client.get(f"/v1/admin/requests/{request.id}", headers=agent.headers)
    listed = await db_client.get(
        "/v1/admin/requests", params={"bucket": "new"}, headers=agent.headers
    )

    assert card.status_code == 200, card.text
    shown = card.json()
    assert (shown["origin"], shown["utm"]) == ("web", UTM)
    assert {key: shown["customer"][key] for key in ("first_name", "email", "phone")} == {
        "first_name": FIRST,
        "email": EMAIL,
        "phone": PHONE,
    }
    assert (shown["customer"]["has_account"], shown["customer"]["last_name"]) == (False, None)
    [item] = [i for i in listed.json()["items"] if i["id"] == str(request.id)]
    assert item["customer_name"] == FIRST
    for other in (customer, pro):
        refused = await db_client.get(f"/v1/admin/requests/{request.id}", headers=other.headers)
        assert refused.status_code == 403
        assert all(leak not in refused.text for leak in (FIRST, EMAIL, PHONE))
    mine = await db_client.get(f"/v1/requests/{request.id}", headers=customer.headers)
    assert mine.status_code == 404
    assert all(leak not in mine.text for leak in (FIRST, EMAIL, PHONE))


# --- The guest: never dispatched, never signs in --------------------------------------------


async def test_a_guest_s_request_is_never_dispatched_or_assigned(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    category = await make_category(db_session)
    assert (await send(db_client, body(category_id=str(category)))).status_code == 201
    [request] = await web_requests(db_session)
    request_id = request.id
    dispatch = DispatchService(db_session)
    admin = await make_caller(db_session, UserRole.ADMIN)

    outcome = await dispatch.dispatch(request_id)
    swept = await undispatched_requests(
        db_session,
        select(ServiceRequest.id).where(ServiceRequest.id.is_(None)),
        [RequestStatus.RECEIVED, RequestStatus.REVIEWING],
        created_after=datetime(2000, 1, 1, tzinfo=UTC),
        limit=100,
    )
    assigned = await db_client.post(
        f"/v1/admin/requests/{request_id}/assign",
        json={"pro_id": str(uuid.uuid4())},
        headers=admin.headers,
    )

    assert outcome.outcome is DispatchOutcome.NO_ACCOUNT
    assert request_id not in {row.id for row in swept}
    assert (assigned.status_code, assigned.json()["error"]["code"]) == (
        409,
        "request_without_account",
    )
    assert AssignRefusal.NO_ACCOUNT.value == "no_account"
    assert (await web_requests(db_session))[0].status is RequestStatus.RECEIVED


async def test_a_guest_never_signs_in(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    assert (await send(db_client)).status_code == 201
    [guest] = await guests(db_session)
    guest_id = guest.id

    # Its stored email is not even one a sign-in takes (the reserved .invalid domain).
    stored = await db_client.post("/v1/auth/login", json={"email": guest.email, "password": "x"})
    assert stored.status_code == 422, stored.text
    # Given a real email and a password that verifies, it is still refused, by its status
    # alone, as a wrong password is.
    password = "Correct-horse-battery-86"
    await db_session.execute(
        update(User)
        .where(User.id == guest_id)
        .values(email="guest-probe-86@example.com", password_hash=hash_password(password))
    )
    await db_session.flush()
    answer = await db_client.post(
        "/v1/auth/login", json={"email": "guest-probe-86@example.com", "password": password}
    )
    assert (answer.status_code, answer.json()["error"]["code"]) == (
        401,
        "invalid_credentials",
    ), answer.text


# --- The ZIP check and the waitlist count the forwarded visitor behind the key -------------


@pytest.mark.parametrize("keyed", [True, False])
async def test_the_zip_check_and_the_waitlist_count_the_forwarded_visitor_behind_the_key(
    app: FastAPI, db_client: httpx.AsyncClient, keyed: bool
) -> None:
    limiter = RecordingLimiter()
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    headers = web() if keyed else web(key=None)  # a forged address without the key

    checked = await db_client.get(
        "/v1/service-areas/check", params={"zip": "99501"}, headers=headers
    )
    joined = await db_client.post(
        "/v1/waitlist",
        json={"zip_code": "99501", "email": EMAIL, "source": "web"},
        headers=headers,
    )

    assert (checked.status_code, joined.status_code) == (200, 202)
    ips = [
        identifier
        for scope, identifier, _, _ in limiter.hits
        if scope.endswith("_ip") or scope == "catalog_zip_check"
    ]
    assert ips
    assert set(ips) == ({VISITOR} if keyed else {"127.0.0.1"})


# --- Real commits: a race of one key -------------------------------------------------------


@dataclass(frozen=True)
class CommittedArea:
    client: httpx.AsyncClient
    sessions: async_sessionmaker[AsyncSession]


@pytest.fixture
async def area(app: FastAPI, committed: Committed) -> AsyncIterator[CommittedArea]:
    app.dependency_overrides[get_rate_limiter] = lambda: RecordingLimiter()
    async with committed.sessions() as session:
        row = ServiceArea(
            region="Web race", city="Orlando", state="FL", zip_code=ADDRESS["zip_code"]
        )
        session.add(row)
        await session.commit()
    try:
        yield CommittedArea(committed.client, committed.sessions)
    finally:
        async with committed.sessions() as session:
            requests = select(WebRequestContact.request_id).where(WebRequestContact.email == EMAIL)
            customers = select(ServiceRequest.customer_id).where(ServiceRequest.id.in_(requests))
            ids = list((await session.scalars(customers)).all())
            await session.execute(delete(WebRequestContact).where(WebRequestContact.email == EMAIL))
            await session.execute(delete(ServiceRequest).where(ServiceRequest.customer_id.in_(ids)))
            await session.execute(delete(Address).where(Address.user_id.in_(ids)))
            await session.execute(delete(User).where(User.id.in_(ids)))
            await session.execute(delete(ServiceArea).where(ServiceArea.id == row.id))
            await session.commit()


async def test_simultaneous_creates_with_one_key_make_one_request(area: CommittedArea) -> None:
    key = str(uuid.uuid4())

    async with asyncio.timeout(15):
        answers = await asyncio.gather(*(send(area.client, key=key) for _ in range(5)))

    assert [answer.status_code for answer in answers] == [201] * 5
    assert len({answer.json()["public_code"] for answer in answers}) == 1
    async with area.sessions() as session:
        contacts = (
            await session.scalars(select(WebRequestContact).where(WebRequestContact.email == EMAIL))
        ).all()
        assert len(contacts) == 1
        [request] = (
            await session.scalars(
                select(ServiceRequest).where(ServiceRequest.id == contacts[0].request_id)
            )
        ).all()
        # The losers' guests rolled back with their requests: one guest, the winner's.
        made = select(func.count()).select_from(User).where(User.status == UserStatus.GUEST)
        assert await session.scalar(made.where(User.id == request.customer_id)) == 1
        assert answers[0].json()["public_code"] == request.public_code
