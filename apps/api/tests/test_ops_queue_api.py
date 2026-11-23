"""The BDC's operations queue (D16.2, #81): GET /v1/admin/requests, GET .../summary,
GET .../{id} (the card), POST .../{id}/claim and POST .../{id}/release."""

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings, get_app_settings
from app.integrations.storage import get_storage_provider
from app.modules.addresses.models import Address
from app.modules.audit.repository import AuditRepository
from app.modules.audit.service import AuditService
from app.modules.audit.types import ActorNotStaffError, AuditAction, ReaderNotStaffError
from app.modules.categories.models import Category
from app.modules.jobs.models import JobEvent, JobStatus
from app.modules.media.safe_status import MediaSafeStatus
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.requests.models import (
    RequestMedia,
    RequestMediaKind,
    RequestOrigin,
    RequestStatus,
    ServiceRequest,
)
from app.modules.support.models import SupportTicket, TicketRole, TicketStatus, TicketTopic
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from tests.audit_helpers import AuditRow, audit_rows
from tests.conftest import Committed, make_settings
from tests.helpers import as_status_writer
from tests.job_world import (
    CUSTOMER_EMAIL,
    CUSTOMER_FIRST,
    CUSTOMER_LAST,
    CUSTOMER_PHONE,
    DESCRIPTION,
    LINE1,
    LINE2,
    PRICE,
    PRO_EMAIL,
    PRO_PHONE,
    JobWorld,
    Party,
    build_world,
    headers_for,
    make_job,
)
from tests.test_pros_profile_api import FakeStorage

BASE = "/v1/admin/requests"
SUMMARY = f"{BASE}/summary"
SLA = 7  # minutes; not the default (5), so the tests prove it comes from the setting
WAITING = 90  # minutes; not the default (1440)
URL_TTL = 90
PAGE = 3
CONTACT_LEAKS: Final = (CUSTOMER_EMAIL, CUSTOMER_PHONE, CUSTOMER_LAST, LINE1, LINE2)
PRO_LEAKS: Final = (PRO_EMAIL, PRO_PHONE, "Pérez")

FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}
VALIDATION_ERROR = {"error": {"code": "validation_error", "message": "The request is invalid."}}
NOT_FOUND = {"error": {"code": "request_not_found", "message": "Request not found."}}
HELD = {"error": {"code": "request_held", "message": "Another team member holds this request."}}
ITEM_KEYS = {
    "id",
    "public_code",
    "customer_name",
    "customer_deleted",
    "category",
    "zip_code",
    "status",
    "customer_status",
    "origin",
    "urgency",
    "bucket",
    "created_at",
    "first_contact_due_at",
    "first_contact_at",
    "assigned_agent",
    "media_count",
}
BUCKETS = (
    "problems",
    "urgent",
    "new",
    "waiting_customer",
    "waiting_pro",
    "quote_ready",
    "scheduled_today",
)


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        ops_first_contact_sla_minutes=SLA,
        ops_quote_waiting_minutes=WAITING,
        request_list_default_limit=PAGE,
        download_url_ttl_seconds=URL_TTL,
    )


@pytest.fixture
def storage(app: FastAPI) -> FakeStorage:
    fake = FakeStorage()
    app.dependency_overrides[get_storage_provider] = lambda: lambda: fake
    return fake


@pytest.fixture
async def world(db_session: AsyncSession, storage: FakeStorage) -> JobWorld:
    return await build_world(db_session)


def minutes(count: int) -> timedelta:
    return timedelta(minutes=count)


async def db_now(session: AsyncSession) -> datetime:
    return (await session.execute(select(func.now()))).scalar_one()


async def make_request(
    session: AsyncSession,
    world: JobWorld,
    status: RequestStatus = RequestStatus.RECEIVED,
    *,
    age: timedelta = timedelta(0),
    **fields: Any,
) -> ServiceRequest:
    """A request of the world's customer in `status`, created `age` ago by the database clock."""
    values: dict[str, Any] = {
        "customer_id": world.customer.id,
        "address_id": world.address_id,
        "category_id": world.category_id,
        "description": f"{DESCRIPTION}, call {CUSTOMER_PHONE}",
        "origin": RequestOrigin.APP,
        **fields,
    }
    request = ServiceRequest(status=status, created_at=await db_now(session) - age, **values)
    async with as_status_writer(session):  # the database guard (#163)
        session.add(request)
        await session.flush()
    return request


async def add_quote(
    session: AsyncSession,
    world: JobWorld,
    request: ServiceRequest,
    *,
    age: timedelta = timedelta(0),
    status: QuoteStatus = QuoteStatus.PENDING,
) -> Quote:
    now = await db_now(session)
    quote = Quote(
        request_id=request.id,
        pro_id=world.pro.profile_id,
        amount_cents=PRICE,
        scope="Replace the cartridge",
        duration_minutes=60,
        proposed_start_at=now + timedelta(days=3),
        expires_at=now + timedelta(days=2),
        status=status,
        created_at=now - age,
    )
    session.add(quote)
    await session.flush()
    return quote


async def add_ticket(
    session: AsyncSession, world: JobWorld, job_id: uuid.UUID, status: TicketStatus
) -> None:
    session.add(
        SupportTicket(
            user_id=world.customer.id,
            role=TicketRole.CUSTOMER,
            topic=TicketTopic.JOB,
            message="The pro did not show up.",
            job_id=job_id,
            status=status,
            closed_at=await db_now(session) if status == TicketStatus.CLOSED else None,
        )
    )
    await session.flush()


async def request_row(session: AsyncSession, request_id: uuid.UUID) -> ServiceRequest:
    statement = (
        select(ServiceRequest)
        .where(ServiceRequest.id == request_id)
        .execution_options(populate_existing=True)
    )
    return (await session.scalars(statement)).one()


def ids(response: httpx.Response) -> list[str]:
    assert response.status_code == 200, response.text
    return [item["id"] for item in response.json()["items"]]


def one(request: ServiceRequest) -> str:
    return f"{BASE}/{request.id}"


# --- Who may call ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", BASE),
        ("GET", SUMMARY),
        ("GET", f"{BASE}/{uuid.uuid4()}"),
        ("POST", f"{BASE}/{uuid.uuid4()}/claim"),
        ("POST", f"{BASE}/{uuid.uuid4()}/release"),
    ],
)
async def test_no_token_is_401(db_client: httpx.AsyncClient, method: str, path: str) -> None:
    response = await db_client.request(method, path)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_token"
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("who", ["customer", "other_customer", "pro"])
async def test_the_apps_users_are_refused_even_the_requests_own_customer(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, who: str
) -> None:
    request = await make_request(db_session, world)
    headers = getattr(world, who).headers

    responses = [
        await db_client.get(BASE, headers=headers),
        await db_client.get(SUMMARY, headers=headers),
        await db_client.get(one(request), headers=headers),
        await db_client.post(f"{one(request)}/claim", headers=headers),
        await db_client.post(f"{one(request)}/release", headers=headers),
    ]

    assert [(r.status_code, r.json()) for r in responses] == [(403, FORBIDDEN)] * 5
    assert all(r.headers["cache-control"] == "no-store" for r in responses)
    assert (await request_row(db_session, request.id)).assigned_agent_id is None
    assert await audit_rows(db_session) == []


@pytest.mark.parametrize("staff", ["agent", "admin"])
async def test_agents_and_admins_work_the_queue(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, staff: str
) -> None:
    request = await make_request(db_session, world)
    headers = getattr(world, staff).headers

    responses = [
        await db_client.get(BASE, headers=headers),
        await db_client.get(SUMMARY, headers=headers),
        await db_client.get(one(request), headers=headers),
        await db_client.post(f"{one(request)}/claim", headers=headers),
        await db_client.post(f"{one(request)}/release", headers=headers),
    ]

    assert [r.status_code for r in responses] == [200] * 5, [r.text for r in responses]
    assert all(r.headers["cache-control"] == "no-store" for r in responses)


# --- Buckets ---------------------------------------------------------------------------------


async def test_every_request_is_in_one_bucket_by_precedence_and_the_settings(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    in_status = RequestStatus
    now = await db_now(db_session)
    disputed = await make_job(db_session, world, JobStatus.DISPUTED)
    with_ticket = await make_job(db_session, world, start=now + timedelta(days=3))
    await add_ticket(db_session, world, with_ticket.id, TicketStatus.IN_PROGRESS)
    settled = await make_job(db_session, world, start=now + timedelta(days=3))
    await add_ticket(db_session, world, settled.id, TicketStatus.CLOSED)
    today = await make_job(db_session, world, JobStatus.ON_THE_WAY, start=now)
    done_today = await make_job(db_session, world, JobStatus.COMPLETED, start=now)
    # Older than the default first-contact time (5), younger than the setting's (7): still new.
    fresh = await make_request(db_session, world, age=minutes(SLA - 1))
    late = await make_request(db_session, world, age=minutes(SLA + 1))
    flagged = await make_request(db_session, world, urgency="high")
    # Late and in review: urgent comes before waiting on the customer.
    late_review = await make_request(db_session, world, in_status.REVIEWING, age=minutes(SLA + 1))
    # Contacted, so never urgent again; nobody holds it: new.
    contacted = await make_request(
        db_session, world, age=minutes(60), first_contact_at=now, urgency="high"
    )
    held = await make_request(db_session, world, age=minutes(1), assigned_agent_id=world.agent.id)
    in_review = await make_request(
        db_session, world, in_status.REVIEWING, age=minutes(60), first_contact_at=now
    )
    stale_quote = await make_request(db_session, world, in_status.QUOTE_READY, age=minutes(300))
    # Older than the setting (90 minutes), far younger than the default (a day).
    await add_quote(db_session, world, stale_quote, age=minutes(WAITING + 1))
    fresh_quote = await make_request(db_session, world, in_status.QUOTE_READY, age=minutes(300))
    await add_quote(db_session, world, fresh_quote, age=minutes(WAITING - 1))
    searching = await make_request(db_session, world, in_status.FINDING_PRO, age=minutes(300))
    # A quote arrived and the status has not followed yet: no longer waiting for a pro.
    answered = await make_request(db_session, world, in_status.FINDING_PRO, age=minutes(300))
    await add_quote(db_session, world, answered)
    # A late request already sent to pros is not a first-contact case.
    cancelled = await make_request(db_session, world, in_status.CANCELLED, age=minutes(300))
    expected = {
        disputed.request_id: "problems",
        with_ticket.request_id: "problems",
        settled.request_id: "other",
        today.request_id: "scheduled_today",
        done_today.request_id: "other",
        fresh.id: "new",
        late.id: "urgent",
        flagged.id: "urgent",
        late_review.id: "urgent",
        contacted.id: "new",
        held.id: "other",
        in_review.id: "waiting_customer",
        stale_quote.id: "waiting_customer",
        fresh_quote.id: "quote_ready",
        searching.id: "waiting_pro",
        answered.id: "other",
        cancelled.id: "other",
    }
    staff = world.agent.headers

    everything = await db_client.get(BASE, params={"limit": 50}, headers=staff)
    summary = await db_client.get(SUMMARY, headers=staff)
    by_bucket = {
        bucket: await db_client.get(BASE, params={"bucket": bucket, "limit": 50}, headers=staff)
        for bucket in BUCKETS
    }

    assert everything.status_code == 200, everything.text
    assert {item["id"]: item["bucket"] for item in everything.json()["items"]} == {
        str(request_id): bucket for request_id, bucket in expected.items()
    }
    for bucket, response in by_bucket.items():
        assert set(ids(response)) == {
            str(request_id) for request_id, name in expected.items() if name == bucket
        }, bucket
        assert {item["bucket"] for item in response.json()["items"]} == {bucket}
    assert summary.json() == {
        "problems": 2,
        "urgent": 3,
        "new": 2,
        "waiting_customer": 2,
        "waiting_pro": 1,
        "quote_ready": 1,
        "scheduled_today": 1,
        "all": len(expected),
        "first_contact_sla_minutes": SLA,
    }
    # Inside a bucket the request waiting longest comes first.
    assert ids(by_bucket["new"]) == [str(contacted.id), str(fresh.id)]
    for leak in (*CONTACT_LEAKS, *PRO_LEAKS):
        assert leak not in summary.text


def zone_where_it_is(hour: int, now: datetime) -> str:
    """A fixed-offset zone in which the wall clock reads `hour` now. POSIX names invert the
    sign: Etc/GMT-3 is three hours ahead of UTC."""
    offset = (hour - now.astimezone(UTC).hour + 12) % 24 - 12
    return f"Etc/GMT{-offset:+d}"


@pytest.mark.parametrize(("local_hour", "bucket"), [(6, "scheduled_today"), (18, "other")])
async def test_scheduled_today_is_read_in_the_business_time_zone(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    app: FastAPI,
    local_hour: int,
    bucket: str,
) -> None:
    now = await db_now(db_session)
    # Twelve hours from now: the same day where it is 6 in the morning, the next day where it
    # is 6 in the evening. Only the setting tells the two apart.
    job = await make_job(db_session, world, start=now + timedelta(hours=12))
    zone = zone_where_it_is(local_hour, now)
    app.dependency_overrides[get_app_settings] = lambda: make_settings(
        business_time_zone=zone, request_list_default_limit=PAGE
    )

    listed = await db_client.get(BASE, headers=world.agent.headers)
    summary = await db_client.get(SUMMARY, headers=world.agent.headers)

    assert [(item["id"], item["bucket"]) for item in listed.json()["items"]] == [
        (str(job.request_id), bucket)
    ], zone
    assert summary.json()["scheduled_today"] == (1 if bucket == "scheduled_today" else 0)


# --- The list --------------------------------------------------------------------------------


async def test_a_list_item_shows_no_contact(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    request = await make_request(
        db_session, world, age=timedelta(minutes=2), assigned_agent_id=world.agent.id
    )
    db_session.add(
        RequestMedia(
            request_id=request.id,
            kind=RequestMediaKind.PHOTO,
            file_key=f"u/{world.customer.id}/request_media/{uuid.uuid4().hex}.jpg",
        )
    )
    await db_session.execute(
        update(User)
        .where(User.id == world.agent.id)
        .values(first_name="Eva", last_name="Agentlast")
    )
    unclassified = await make_request(db_session, world, category_id=None, origin=RequestOrigin.WEB)

    response = await db_client.get(BASE, headers=world.admin.headers)

    assert response.headers["cache-control"] == "no-store"
    newest, older = response.json()["items"]  # bucket=all: newest first
    assert (newest["id"], older["id"]) == (str(unclassified.id), str(request.id))
    assert set(older) == ITEM_KEYS
    assert (older["public_code"], older["customer_name"], older["zip_code"]) == (
        request.public_code,
        f"{CUSTOMER_FIRST} P.",
        "32801",
    )
    assert older["category"] == {
        "id": str(world.category_id),
        "slug": older["category"]["slug"],
        "names": {"en": "Plumbing", "es": "Plomería"},
    }
    assert (older["status"], older["customer_status"], older["origin"], older["bucket"]) == (
        "received",
        "customerStatus.requestReceived",
        "app",
        "other",
    )
    assert older["assigned_agent"] == {"id": str(world.agent.id), "name": "Eva"}
    assert (older["media_count"], older["first_contact_at"], older["urgency"]) == (1, None, None)
    due = datetime.fromisoformat(older["first_contact_due_at"])
    assert due - datetime.fromisoformat(older["created_at"]) == timedelta(minutes=SLA)
    assert (newest["category"], newest["origin"], newest["assigned_agent"]) == (None, "web", None)
    assert (newest["bucket"], newest["media_count"]) == ("new", 0)
    for leak in (*CONTACT_LEAKS, "Agentlast", DESCRIPTION):
        assert leak not in response.text


async def test_the_list_filters(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    other_category = Category(slug=f"test-{uuid.uuid4().hex[:8]}", names={"en": "x", "es": "x"})
    elsewhere = Address(
        user_id=world.customer.id,
        line1="9 Other Road",
        city="Miami",
        state="FL",
        zip_code="33101-1234",
    )
    db_session.add_all([other_category, elsewhere])
    await db_session.flush()
    mine = await make_request(db_session, world, assigned_agent_id=world.agent.id)
    theirs = await make_request(db_session, world, assigned_agent_id=world.admin.id)
    free = await make_request(db_session, world, RequestStatus.FINDING_PRO)
    moved = await make_request(
        db_session, world, address_id=elsewhere.id, category_id=other_category.id
    )
    staff = world.agent.headers

    async def listed(**params: str) -> set[str]:
        return set(ids(await db_client.get(BASE, params={"limit": "50", **params}, headers=staff)))

    everything = {str(r.id) for r in (mine, theirs, free, moved)}
    assert await listed() == everything
    assert await listed(assigned="any") == everything
    assert await listed(assigned="me") == {str(mine.id)}
    assert await listed(assigned="unassigned") == {str(free.id), str(moved.id)}
    assert await listed(status="finding_pro") == {str(free.id)}
    assert await listed(category_id=str(other_category.id)) == {str(moved.id)}
    assert await listed(zip="33101") == {str(moved.id)}
    assert await listed(zip="32801") == everything - {str(moved.id)}
    assert await listed(q=mine.public_code) == {str(mine.id)}
    assert await listed(q=mine.public_code.lower()[3:]) == {str(mine.id)}
    assert await listed(q="JF-") == everything
    assert await listed(bucket="waiting_pro", assigned="unassigned", zip="32801") == {str(free.id)}
    for bad in (
        {"bucket": "other"},
        {"status": "paid"},
        {"assigned": "them"},
        {"zip": "3310"},
        {"zip": "33101-1234"},
        {"q": "JF-%"},
        {"q": "x" * 17},
        {"category_id": "plumbing"},
        {"limit": "0"},
        {"cursor": "not-a-cursor"},
    ):
        refused = await db_client.get(BASE, params=bad, headers=staff)
        assert (refused.status_code, refused.json()) == (422, VALIDATION_ERROR), bad


async def test_the_list_pages_with_a_cursor_in_each_order(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    requests = [
        await make_request(db_session, world, age=timedelta(seconds=10 * n)) for n in range(5)
    ]
    newest_first = [str(request.id) for request in requests]
    staff = world.agent.headers

    async def pages(**params: str) -> list[list[str]]:
        found, cursor = [], None
        while True:
            query = {**params, **({"cursor": cursor} if cursor else {})}
            response = await db_client.get(BASE, params=query, headers=staff)
            found.append(ids(response))
            cursor = response.json()["next_cursor"]
            if cursor is None:
                return found

    # The setting's page size (3); bucket=all newest first, a bucket oldest first.
    assert await pages() == [newest_first[:3], newest_first[3:]]
    assert await pages(bucket="new") == [newest_first[::-1][:3], newest_first[::-1][3:]]
    capped = await db_client.get(BASE, params={"limit": 10_000}, headers=staff)
    assert ids(capped) == newest_first


async def test_requests_created_at_the_same_instant_are_paged_once_each(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    # One transaction, one clock: the four share created_at, so only the id orders them.
    created = {str((await make_request(db_session, world)).id) for _ in range(4)}
    staff = world.agent.headers

    for params in ({}, {"bucket": "new"}):
        first = await db_client.get(BASE, params=params, headers=staff)
        second = await db_client.get(
            BASE, params={**params, "cursor": first.json()["next_cursor"]}, headers=staff
        )

        assert (len(ids(first)), len(ids(second))) == (PAGE, 1)
        assert set(ids(first)) | set(ids(second)) == created
        assert second.json()["next_cursor"] is None


# --- The card --------------------------------------------------------------------------------


async def test_the_card_shows_who_to_call_and_audits_the_read(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, storage: FakeStorage
) -> None:
    now = await db_now(db_session)
    job = await make_job(db_session, world, JobStatus.ON_THE_WAY, start=now)
    db_session.add(
        JobEvent(
            job_id=job.id,
            type="status_changed",
            from_status=JobStatus.SCHEDULED,
            to_status=JobStatus.ON_THE_WAY,
            actor_id=world.pro.id,
        )
    )
    request = await request_row(db_session, job.request_id)
    safe_key = f"m/{uuid.uuid4().hex}.jpg"
    original = f"u/{world.customer.id}/request_media/{uuid.uuid4().hex}.jpg"
    db_session.add_all(
        [
            RequestMedia(
                request_id=request.id,
                kind=RequestMediaKind.PHOTO,
                file_key=original,
                safe_key=safe_key,
                safe_status=MediaSafeStatus.READY,
                safe_content_type="image/jpeg",
            ),
            RequestMedia(
                request_id=request.id,
                kind=RequestMediaKind.VIDEO,
                file_key=f"u/{world.customer.id}/request_media/{uuid.uuid4().hex}.mp4",
            ),
            RequestMedia(
                request_id=request.id,
                kind=RequestMediaKind.PHOTO,
                file_key=f"u/{world.customer.id}/request_media/{uuid.uuid4().hex}.jpg",
                safe_status=MediaSafeStatus.FAILED,
            ),
        ]
    )
    await db_session.flush()

    response = await db_client.get(one(request), headers=world.agent.headers)

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    card = response.json()
    assert set(card) > ITEM_KEYS
    assert card["customer"] == {
        "id": str(world.customer.id),
        "first_name": CUSTOMER_FIRST,
        "last_name": CUSTOMER_LAST,
        "phone": CUSTOMER_PHONE,
        "email": CUSTOMER_EMAIL,
        "language": "en",
        "has_account": True,
    }
    assert card["utm"] is None
    assert card["address"] == {
        "line1": LINE1,
        "line2": LINE2,
        "city": "Orlando",
        "state": "FL",
        "zip_code": "32801",
    }
    # As the customer typed it: the BDC reads the contact the app hides from pros.
    assert card["description"] == f"{DESCRIPTION}, call {CUSTOMER_PHONE}"
    assert (card["status"], card["customer_status"], card["bucket"]) == (
        "accepted",
        "customerStatus.professionalOnTheWay",
        "scheduled_today",
    )
    # Only the privacy-safe copy is signed: never the original, a pending or a failed one.
    [media] = card["media"]
    assert (media["kind"], media["content_type"]) == ("photo", "image/jpeg")
    assert media["url"].endswith(f"{safe_key}?sig=fake")
    assert card["media_pending"] == 1
    assert storage.gets == [(safe_key, URL_TTL)]
    assert original not in response.text
    [quote] = card["quotes"]
    assert (quote["pro_name"], quote["amount_cents"], quote["status"]) == (
        "María P.",
        PRICE,
        "accepted",
    )
    assert (card["job"]["id"], card["job"]["status"]) == (str(job.id), "on_the_way")
    assert datetime.fromisoformat(card["job"]["scheduled_start_at"]) == now
    # Both events share the test transaction's clock: compared whatever their order.
    assert sorted((e["type"], e["to_status"], e["by_system"]) for e in card["job"]["events"]) == [
        ("created", "scheduled", True),
        ("status_changed", "on_the_way", False),
    ]
    for leak in PRO_LEAKS:
        assert leak not in response.text
    assert await audit_rows(db_session) == [
        AuditRow(
            actor_user_id=world.agent.id,
            action="service_request.read_card",
            entity_type="service_request",
            entity_id=request.id,
            before={},
            after={"status": "accepted", "media": 1, "notes": 0, "followups": 0},
            reason=None,
        )
    ]


async def test_a_card_without_media_job_or_quotes(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, app: FastAPI
) -> None:
    # No storage at all: a request without media never needs it.
    app.dependency_overrides[get_storage_provider] = lambda: _no_storage
    request = await make_request(db_session, world, category_id=None)

    response = await db_client.get(one(request), headers=world.admin.headers)

    assert response.status_code == 200, response.text
    card = response.json()
    assert (card["media"], card["media_pending"], card["quotes"], card["job"]) == ([], 0, [], None)
    assert (card["category"], card["bucket"], card["assigned_agent"]) == (None, "new", None)
    assert len(await audit_rows(db_session)) == 1


def _no_storage() -> FakeStorage:
    raise AssertionError("the storage is not needed")


@pytest.mark.parametrize("failure", ["audit_write_fails", "audit_refuses_the_reader"])
async def test_nothing_is_shown_when_the_read_cannot_be_audited(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    request = await make_request(db_session, world)

    if failure == "audit_write_fails":

        async def fail(self: AuditRepository, **fields: Any) -> None:
            raise RuntimeError("probe failure")

        monkeypatch.setattr(AuditRepository, "add", fail)
    else:

        async def refuse(self: AuditService, *args: Any, **kwargs: Any) -> None:
            raise ReaderNotStaffError

        monkeypatch.setattr(AuditService, "record_read", refuse)

    response = await db_client.get(one(request), headers=world.agent.headers)

    assert response.status_code == (500 if failure == "audit_write_fails" else 403)
    assert response.headers["cache-control"] == "no-store"
    for leak in (*CONTACT_LEAKS, CUSTOMER_FIRST, DESCRIPTION):
        assert leak not in response.text


async def test_an_unknown_request_is_404_and_a_bad_id_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    staff = world.agent.headers
    unknown = f"{BASE}/{uuid.uuid4()}"

    responses = [
        await db_client.get(unknown, headers=staff),
        await db_client.post(f"{unknown}/claim", headers=staff),
        await db_client.post(f"{unknown}/release", headers=staff),
    ]
    bad = [
        await db_client.get(f"{BASE}/JF-000124", headers=staff),
        await db_client.post(f"{BASE}/JF-000124/claim", headers=staff),
    ]

    assert [(r.status_code, r.json()) for r in responses] == [(404, NOT_FOUND)] * 3
    assert [(r.status_code, r.json()) for r in bad] == [(422, VALIDATION_ERROR)] * 2
    assert await audit_rows(db_session) == []


# --- Claim and release -----------------------------------------------------------------------


async def test_a_claim_assigns_the_caller_once_and_nobody_else_takes_it(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    request = await make_request(db_session, world, age=timedelta(minutes=1))
    other_agent = await _staff(db_session, UserRole.AGENT)
    claim = f"{one(request)}/claim"

    first = await db_client.post(claim, headers=world.agent.headers)
    again = await db_client.post(claim, headers=world.agent.headers)
    taken = await db_client.post(claim, headers=other_agent.headers)
    admin = await db_client.post(claim, headers=world.admin.headers)
    listed = await db_client.get(BASE, params={"assigned": "me"}, headers=world.agent.headers)

    assert first.status_code == 200, first.text
    assert (
        first.json()
        == again.json()
        == {
            "id": str(request.id),
            "assigned_agent": {"id": str(world.agent.id), "name": None},
        }
    )
    assert [(r.status_code, r.json()) for r in (taken, admin)] == [(409, HELD)] * 2
    assert ids(listed) == [str(request.id)]
    stored = await request_row(db_session, request.id)
    # Taking a request is neither the first contact nor a status change.
    assert (stored.assigned_agent_id, stored.first_contact_at, stored.status) == (
        world.agent.id,
        None,
        RequestStatus.RECEIVED,
    )
    assert await audit_rows(db_session) == [
        AuditRow(
            actor_user_id=world.agent.id,
            action="service_request.claim",
            entity_type="service_request",
            entity_id=request.id,
            before={"assigned_agent_id": None},
            after={"assigned_agent_id": str(world.agent.id)},
            reason=None,
        )
    ]


async def test_a_release_by_the_holder_or_an_admin(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    other_agent = await _staff(db_session, UserRole.AGENT)
    held = await make_request(db_session, world, assigned_agent_id=world.agent.id)
    theirs = await make_request(db_session, world, assigned_agent_id=other_agent.id)
    free = await make_request(db_session, world)
    agent, admin = world.agent.headers, world.admin.headers

    refused = await db_client.post(f"{one(theirs)}/release", headers=agent)
    released = await db_client.post(f"{one(held)}/release", headers=agent)
    again = await db_client.post(f"{one(held)}/release", headers=agent)
    by_admin = await db_client.post(f"{one(theirs)}/release", headers=admin)
    nothing = await db_client.post(f"{one(free)}/release", headers=agent)

    assert (refused.status_code, refused.json()) == (409, HELD)
    assert released.json() == again.json() == {"id": str(held.id), "assigned_agent": None}
    assert by_admin.json() == {"id": str(theirs.id), "assigned_agent": None}
    assert (nothing.status_code, nothing.json()["assigned_agent"]) == (200, None)
    assert (await request_row(db_session, held.id)).assigned_agent_id is None
    assert (await request_row(db_session, theirs.id)).assigned_agent_id is None
    written = [
        (row.actor_user_id, row.action, row.entity_id, row.before, row.after)
        for row in await audit_rows(db_session)
    ]
    expected = [
        (
            world.agent.id,
            "service_request.release",
            held.id,
            {"assigned_agent_id": str(world.agent.id)},
            {"assigned_agent_id": None},
        ),
        (
            world.admin.id,
            "service_request.release",
            theirs.id,
            {"assigned_agent_id": str(other_agent.id)},
            {"assigned_agent_id": None},
        ),
    ]
    # One row per change, whatever their order (they share the transaction's clock).
    assert len(written) == len(expected)
    assert all(change in written for change in expected)


@pytest.mark.parametrize("failure", ["audit_write_fails", "audit_refuses_the_actor"])
async def test_a_claim_that_cannot_be_audited_does_not_happen(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    request = await make_request(db_session, world)
    held = await make_request(db_session, world, assigned_agent_id=world.agent.id)
    urls = (f"{one(request)}/claim", f"{one(held)}/release")
    request_id, held_id = request.id, held.id  # read now: a rollback expires the fixtures
    await db_session.commit()  # the service's rollback must not take the fixtures with it

    if failure == "audit_write_fails":

        async def fail(self: AuditRepository, **fields: Any) -> None:
            raise RuntimeError("probe failure")

        monkeypatch.setattr(AuditRepository, "add", fail)
    else:
        # The refusal itself (who counts as active staff) is proven in test_audit_log.py; here,
        # what the routes do with one: the change is rolled back and the answer is 403.

        async def refuse(self: AuditService, *args: Any, **kwargs: Any) -> None:
            raise ActorNotStaffError

        monkeypatch.setattr(AuditService, "record_staff_action", refuse)

    responses = []
    for url in urls:
        responses.append(await db_client.post(url, headers=world.agent.headers))
        # What the request's own session does when it closes without a commit.
        await db_session.rollback()

    expected = 500 if failure == "audit_write_fails" else 403
    assert [r.status_code for r in responses] == [expected] * 2
    assert (await request_row(db_session, request_id)).assigned_agent_id is None
    assert (await request_row(db_session, held_id)).assigned_agent_id == world.agent.id
    assert await audit_rows(db_session) == []


async def _staff(session: AsyncSession, role: UserRole) -> Party:
    user = User(email=f"{role.value}-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=role)
    session.add(user)
    await session.flush()
    return Party(user.id, headers_for(user.id, role))


@dataclass(frozen=True)
class Racers:
    client: httpx.AsyncClient
    sessions: async_sessionmaker[AsyncSession]
    request_id: uuid.UUID
    agents: tuple[Party, Party]
    audited: list[tuple[uuid.UUID, AuditAction]]  # (actor, action) of each audit row asked for


@pytest.fixture
async def racers(committed: Committed, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[Racers]:
    """Two agents and one unassigned request, committed, and deleted afterwards. The audit
    write is replaced by a record of what was asked for: audit_log is append-only, so a
    committed row could never be cleaned up. The row itself is proven above."""
    audited: list[tuple[uuid.UUID, AuditAction]] = []

    async def no_row(
        self: AuditService, actor_id: uuid.UUID, action: AuditAction, *args: Any, **kwargs: Any
    ) -> None:
        audited.append((actor_id, action))

    monkeypatch.setattr(AuditService, "record_staff_action", no_row)
    tag = uuid.uuid4().hex[:8]
    async with committed.sessions() as session:
        customer = User(email=committed.email, password_hash="x", role=UserRole.CUSTOMER)
        agents = [
            User(email=f"racer-{tag}-{n}@x.com", password_hash="x", role=UserRole.AGENT)
            for n in range(2)
        ]
        session.add_all([customer, *agents])
        await session.flush()
        address = Address(
            user_id=customer.id, line1="1 Race Road", city="Orlando", state="FL", zip_code="32801"
        )
        session.add(address)
        await session.flush()
        request = ServiceRequest(
            customer_id=customer.id,
            address_id=address.id,
            description="race",
            origin=RequestOrigin.APP,
        )
        session.add(request)
        await session.commit()
    parties = (
        Party(agents[0].id, headers_for(agents[0].id, UserRole.AGENT)),
        Party(agents[1].id, headers_for(agents[1].id, UserRole.AGENT)),
    )
    try:
        yield Racers(committed.client, committed.sessions, request.id, parties, audited)
    finally:
        async with committed.sessions() as session:
            await session.execute(delete(ServiceRequest).where(ServiceRequest.id == request.id))
            await session.execute(delete(Address).where(Address.id == address.id))
            await session.execute(delete(User).where(User.id.in_([a.id for a in agents])))
            await session.commit()


async def test_two_agents_claiming_at_once_one_wins_and_the_other_is_409(
    racers: Racers,
) -> None:
    claim = f"{BASE}/{racers.request_id}/claim"

    async with asyncio.timeout(15):
        responses = await asyncio.gather(
            *(racers.client.post(claim, headers=agent.headers) for agent in racers.agents)
        )

    assert sorted(r.status_code for r in responses) == [200, 409]
    [won] = [r for r in responses if r.status_code == 200]
    [lost] = [r for r in responses if r.status_code == 409]
    assert lost.json() == HELD
    async with racers.sessions() as session:
        stored = await request_row(session, racers.request_id)
    assert str(stored.assigned_agent_id) == won.json()["assigned_agent"]["id"]
    # Only the winner's claim asked for an audit row.
    assert racers.audited == [(stored.assigned_agent_id, AuditAction.REQUEST_CLAIM)]


# --- Logs ------------------------------------------------------------------------------------


async def test_logs_carry_ids_only(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    caplog: pytest.LogCaptureFixture,
) -> None:
    request = await make_request(db_session, world)
    staff = world.agent.headers

    with caplog.at_level(logging.DEBUG):
        await db_client.get(BASE, params={"q": request.public_code, "zip": "32801"}, headers=staff)
        await db_client.get(SUMMARY, headers=staff)
        await db_client.get(one(request), headers=staff)
        await db_client.post(f"{one(request)}/claim", headers=staff)
        await db_client.post(f"{one(request)}/release", headers=staff)

    events = {record.getMessage(): record.__dict__ for record in caplog.records}
    read = events["request_card_read_by_staff"]
    assert (read["service_request_id"], read["staff_id"], read["bucket"]) == (
        str(request.id),
        str(world.agent.id),
        "new",
    )
    assert events["request_assignment_changed"]["action"] == "service_request.release"
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]
    logs = "\n".join(JsonFormatter().format(r) + r.getMessage() for r in caplog.records)
    for leak in (*CONTACT_LEAKS, CUSTOMER_FIRST, DESCRIPTION, request.public_code):
        assert leak not in logs
