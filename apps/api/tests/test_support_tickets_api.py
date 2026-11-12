"""Support tickets ("Talk to Jack", #274): a customer or a pro writes to the team
(POST /v1/support/tickets, GET .../mine) and staff work the tickets
(GET, GET by id and PATCH /v1/admin/support/tickets)."""

import logging
import uuid
from datetime import timedelta
from typing import Any, Final

import httpx
import pytest
import sentry_sdk
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.repository import AuditRepository
from app.modules.audit.service import AuditService
from app.modules.audit.types import ActorNotStaffError
from app.modules.support.models import SupportTicket, TicketRole, TicketStatus, TicketTopic
from app.modules.support.repository import SupportTicketRepository
from app.observability import JsonFormatter
from app.rate_limit import get_rate_limiter
from tests.audit_helpers import AuditRow, audit_rows
from tests.conftest import InMemoryRateLimiter, make_settings
from tests.job_world import CUSTOMER_FIRST, LEAKS, JobWorld, Party, build_world, make_job
from tests.test_chat_originals import _app, _client
from tests.test_sentry_scrubbing import TEST_DSN, MemoryTransport, _payloads, sentry_transport

__all__ = ["sentry_transport"]  # a fixture, used by name

BASE = "/v1/support/tickets"
MINE = f"{BASE}/mine"
STAFF = "/v1/admin/support/tickets"
PHONE: Final = "305-555-0142"
EMAIL: Final = "reach.me.274@example.com"
SENTINEL: Final = "zqxj-ticket-sentinel"
MESSAGE: Final = f"The app froze on the payment step {SENTINEL}.\nCall me at {PHONE} or {EMAIL}."
VERSION: Final = "9.8.7 (654)"
TEXT_LEAKS = (SENTINEL, PHONE, EMAIL, VERSION, *LEAKS)
NOW = 1_800_000_000.0  # a fixed clock, so no test straddles two rate-limit windows

VALIDATION_ERROR = {"error": {"code": "validation_error", "message": "The request is invalid."}}
INVALID_JOB = {"error": {"code": "invalid_job", "message": "The job is not one of yours."}}
FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}
NOT_FOUND = {"error": {"code": "ticket_not_found", "message": "Support ticket not found."}}
RATE_LIMITED = {"error": {"code": "rate_limited", "message": "Too many requests. Try again later."}}
ITEM_KEYS = {
    "id",
    "user_id",
    "user_first_name",
    "role",
    "topic",
    "job_id",
    "status",
    "created_at",
}
DETAIL_KEYS = ITEM_KEYS | {"message", "closed_at", "app_version", "platform", "updated_at"}
MINE_KEYS = {"id", "topic", "job_id", "status", "created_at", "closed_at"}


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


def body(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = {"topic": "payment", "message": MESSAGE}
    values.update(overrides)
    return values


async def create(client: httpx.AsyncClient, party: Party, **overrides: Any) -> httpx.Response:
    return await client.post(BASE, json=body(**overrides), headers=party.headers)


async def seed(
    session: AsyncSession,
    writer: Party,
    *,
    role: TicketRole = TicketRole.CUSTOMER,
    status: TicketStatus = TicketStatus.OPEN,
    age: timedelta = timedelta(0),
    **fields: Any,
) -> SupportTicket:
    """A ticket of `writer`, `age` old by the database clock, in `status`."""
    now = (await session.execute(select(func.now()))).scalar_one()
    values: dict[str, Any] = {"topic": TicketTopic.OTHER, "message": MESSAGE, **fields}
    ticket = SupportTicket(
        user_id=writer.id,
        role=role,
        status=status,
        created_at=now - age,
        closed_at=now if status == TicketStatus.CLOSED else None,
        **values,
    )
    session.add(ticket)
    await session.flush()
    return ticket


async def rows(session: AsyncSession) -> list[SupportTicket]:
    statement = (
        select(SupportTicket)
        .order_by(SupportTicket.created_at, SupportTicket.id)
        .execution_options(populate_existing=True)
    )
    return list((await session.scalars(statement)).all())


async def row(session: AsyncSession, ticket_id: object) -> SupportTicket:
    statement = (
        select(SupportTicket)
        .where(SupportTicket.id == ticket_id)
        .execution_options(populate_existing=True)
    )
    return (await session.scalars(statement)).one()


def ids(response: httpx.Response) -> list[str]:
    assert response.status_code == 200, response.text
    return [item["id"] for item in response.json()["items"]]


# --- Writing a ticket ------------------------------------------------------------------------


async def test_a_customer_writes_a_ticket_kept_as_typed(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    response = await create(
        db_client, world.customer, message=f"  {MESSAGE}\n ", app_version=VERSION, platform="ios"
    )

    assert response.status_code == 201, response.text
    answer = response.json()
    assert set(answer) == {"id", "status", "created_at"}
    assert all(leak not in response.text for leak in TEXT_LEAKS)
    assert answer["status"] == "open"
    [ticket] = await rows(db_session)
    assert (str(ticket.id), ticket.user_id) == (answer["id"], world.customer.id)
    assert (ticket.role, ticket.topic) == (TicketRole.CUSTOMER, TicketTopic.PAYMENT)
    # Trimmed, and otherwise as typed: the phone and the email are for the team to use.
    assert ticket.message == MESSAGE
    assert (ticket.job_id, ticket.status, ticket.closed_at) == (None, TicketStatus.OPEN, None)
    assert (ticket.app_version, ticket.platform) == (VERSION, "ios")


@pytest.mark.parametrize("writer", ["customer", "pro"])
async def test_a_ticket_about_a_job_of_the_writer(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, writer: str
) -> None:
    job = await make_job(db_session, world)
    party = world.customer if writer == "customer" else world.pro

    response = await create(db_client, party, topic="job", job_id=str(job.id))

    assert response.status_code == 201, response.text
    [ticket] = await rows(db_session)
    assert (ticket.job_id, ticket.role.value, ticket.user_id) == (job.id, writer, party.id)


@pytest.mark.parametrize("who", ["other_customer", "other_pro", "unknown_job"])
async def test_a_job_of_others_is_refused_like_an_unknown_one(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, who: str
) -> None:
    job = await make_job(db_session, world)
    party = world.other_pro if who == "other_pro" else world.other_customer
    job_id = uuid.uuid4() if who == "unknown_job" else job.id

    response = await create(db_client, party, topic="job", job_id=str(job_id))

    assert (response.status_code, response.json()) == (422, INVALID_JOB)
    assert await rows(db_session) == []


@pytest.mark.parametrize(
    "change",
    [
        {"message": "x" * 2001},
        {"message": ""},
        {"message": " \n\t "},
        {"message": "nul \x00 byte"},
        {"message": None},
        {"topic": "billing"},
        {"topic": None},
        {"platform": "web"},
        {"app_version": "x" * 33},
        {"app_version": "1.0\n<script>"},
        {"app_version": ""},
        {"job_id": "not-a-uuid"},
        {"status": "closed"},
        {"user_id": str(uuid.uuid4())},
    ],
    ids=lambda change: next(iter(change)) + ":" + repr(next(iter(change.values())))[:12],
)
async def test_an_invalid_ticket_is_422_and_stores_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, change: dict[str, Any]
) -> None:
    response = await create(db_client, world.customer, **change)

    assert (response.status_code, response.json()) == (422, VALIDATION_ERROR)
    assert await rows(db_session) == []


async def test_the_longest_message_is_accepted(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    response = await create(db_client, world.pro, message="é" * 2000)

    assert response.status_code == 201, response.text
    assert [len(ticket.message) for ticket in await rows(db_session)] == [2000]


async def test_writes_are_rate_limited_per_user(db_session: AsyncSession, world: JobWorld) -> None:
    app = _app(
        make_settings(support_ticket_create_limit=2, support_ticket_create_window_seconds=3_600),
        db_session,
    )
    limiter = InMemoryRateLimiter(lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    async with _client(app) as client:
        # A refused attempt counts: the limit bounds the attempts, not the rows.
        statuses = [
            (await create(client, world.customer, message="")).status_code,
            (await create(client, world.customer)).status_code,
        ]
        limited = await create(client, world.customer)
        other = await create(client, world.pro)
        mine = await client.get(MINE, headers=world.customer.headers)

    assert statuses == [422, 201]
    assert (limited.status_code, limited.json()) == (429, RATE_LIMITED)
    assert int(limited.headers["Retry-After"]) > 0
    # Another user has their own count, and reading is not limited.
    assert (other.status_code, mine.status_code) == (201, 200)
    assert sorted(ticket.user_id for ticket in await rows(db_session)) == sorted(
        [world.customer.id, world.pro.id]
    )


# --- Who may call what -----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", BASE),
        ("GET", MINE),
        ("GET", STAFF),
        ("GET", f"{STAFF}/{uuid.uuid4()}"),
        ("PATCH", f"{STAFF}/{uuid.uuid4()}"),
    ],
)
async def test_no_token_is_401(db_client: httpx.AsyncClient, method: str, path: str) -> None:
    response = await db_client.request(method, path, json=body())

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_token"


@pytest.mark.parametrize("staff", ["agent", "admin"])
async def test_staff_write_no_tickets(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, staff: str
) -> None:
    party: Party = getattr(world, staff)

    created = await create(db_client, party)
    mine = await db_client.get(MINE, headers=party.headers)

    assert (created.status_code, created.json()) == (403, FORBIDDEN)
    assert (mine.status_code, mine.json()) == (403, FORBIDDEN)
    assert await rows(db_session) == []


@pytest.mark.parametrize("who", ["customer", "pro", "other_customer"])
async def test_the_staff_routes_refuse_the_apps_users_even_the_writer(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, who: str
) -> None:
    ticket = await seed(db_session, world.customer)
    party: Party = getattr(world, who)
    one = f"{STAFF}/{ticket.id}"

    responses = [
        await db_client.get(STAFF, headers=party.headers),
        await db_client.get(one, headers=party.headers),
        await db_client.patch(one, json={"status": "closed"}, headers=party.headers),
    ]

    assert [(r.status_code, r.json()) for r in responses] == [(403, FORBIDDEN)] * 3
    assert all(SENTINEL not in r.text for r in responses)
    assert (await row(db_session, ticket.id)).status == TicketStatus.OPEN
    assert await audit_rows(db_session) == []


# --- My tickets ------------------------------------------------------------------------------


async def test_mine_lists_only_the_callers_tickets_newest_first_without_the_message(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    oldest = await seed(
        db_session, world.customer, age=timedelta(hours=3), job_id=job.id, app_version=VERSION
    )
    middle = await seed(
        db_session, world.customer, age=timedelta(hours=2), status=TicketStatus.CLOSED
    )
    newest = await seed(db_session, world.customer, age=timedelta(hours=1))
    theirs = await seed(db_session, world.other_customer, age=timedelta(minutes=30))
    theirs_older = await seed(db_session, world.other_customer, age=timedelta(hours=5))

    first = await db_client.get(MINE, params={"limit": 2}, headers=world.customer.headers)
    cursor = first.json()["next_cursor"]
    second = await db_client.get(
        MINE, params={"limit": 2, "cursor": cursor}, headers=world.customer.headers
    )
    # The same cursor in another user's hands only positions their own list: their tickets
    # older than it, never the first customer's (whose oldest is older than the cursor too).
    others = await db_client.get(
        MINE, params={"cursor": cursor}, headers=world.other_customer.headers
    )
    other_customer = await db_client.get(MINE, headers=world.other_customer.headers)

    assert ids(first) == [str(newest.id), str(middle.id)]
    assert ids(second) == [str(oldest.id)]
    assert second.json()["next_cursor"] is None
    assert ids(others) == [str(theirs_older.id)]
    assert ids(other_customer) == [str(theirs.id), str(theirs_older.id)]
    # No list carries the text, not even the writer's own: every item of every page is without
    # the field, and no body holds a word of the message, its phone or its email.
    pages = (first, second, others, other_customer)
    items = [item for page in pages for item in page.json()["items"]]
    assert len(items) == 6
    assert all(set(item) == MINE_KEYS and "message" not in item for item in items)
    assert all(leak not in page.text for page in pages for leak in TEXT_LEAKS)
    closed, last = first.json()["items"][1], second.json()["items"][0]
    assert (closed["status"], closed["closed_at"] is not None) == ("closed", True)
    assert last == {
        "id": str(oldest.id),
        "topic": "other",
        "job_id": str(job.id),
        "status": "open",
        "created_at": last["created_at"],
        "closed_at": None,
    }


@pytest.mark.parametrize("path", [MINE, STAFF])
@pytest.mark.parametrize("cursor", ["!!", "bm90LWEtY3Vyc29y", "x" * 201])
async def test_a_bad_cursor_is_422(
    db_client: httpx.AsyncClient, world: JobWorld, path: str, cursor: str
) -> None:
    party = world.customer if path == MINE else world.agent

    response = await db_client.get(path, params={"cursor": cursor}, headers=party.headers)

    assert (response.status_code, response.json()) == (422, VALIDATION_ERROR)


# --- Staff: the list -------------------------------------------------------------------------


@pytest.mark.parametrize("staff", ["agent", "admin"])
async def test_staff_list_every_ticket_newest_first_without_the_message(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, staff: str
) -> None:
    job = await make_job(db_session, world)
    party: Party = getattr(world, staff)
    old = await seed(db_session, world.customer, age=timedelta(hours=3), job_id=job.id)
    closed = await seed(
        db_session,
        world.pro,
        role=TicketRole.PRO,
        age=timedelta(hours=2),
        status=TicketStatus.CLOSED,
    )
    new = await seed(db_session, world.other_customer, age=timedelta(hours=1))

    everything = await db_client.get(STAFF, headers=party.headers)
    first = await db_client.get(STAFF, params={"limit": 2}, headers=party.headers)
    second = await db_client.get(
        STAFF, params={"limit": 2, "cursor": first.json()["next_cursor"]}, headers=party.headers
    )

    assert ids(everything) == [str(new.id), str(closed.id), str(old.id)]
    assert everything.json()["next_cursor"] is None
    assert (ids(first), ids(second)) == ([str(new.id), str(closed.id)], [str(old.id)])
    assert all(leak not in everything.text for leak in TEXT_LEAKS)
    newest, middle, oldest = everything.json()["items"]
    assert set(oldest) == ITEM_KEYS
    assert oldest == {
        "id": str(old.id),
        "user_id": str(world.customer.id),
        "user_first_name": CUSTOMER_FIRST,
        "role": "customer",
        "topic": "other",
        "job_id": str(job.id),
        "status": "open",
        "created_at": oldest["created_at"],
    }
    assert (middle["role"], middle["status"], middle["user_first_name"]) == (
        "pro",
        "closed",
        "María",
    )
    # A writer without a name on file.
    assert (newest["user_first_name"], newest["job_id"]) == (None, None)


async def test_staff_filter_the_list_by_status(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    tickets = {
        status: await seed(db_session, world.customer, status=status, age=timedelta(hours=hours))
        for hours, status in enumerate(TicketStatus, start=1)
    }
    headers = world.agent.headers

    for status, ticket in tickets.items():
        listed = await db_client.get(STAFF, params={"status": status.value}, headers=headers)
        assert ids(listed) == [str(ticket.id)]
    unknown = await db_client.get(STAFF, params={"status": "archived"}, headers=headers)
    assert (unknown.status_code, unknown.json()) == (422, VALIDATION_ERROR)


# --- Staff: one ticket -----------------------------------------------------------------------


async def test_staff_read_one_ticket_with_its_message(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    ticket = await seed(
        db_session,
        world.pro,
        role=TicketRole.PRO,
        topic=TicketTopic.SAFETY,
        job_id=job.id,
        app_version=VERSION,
        platform="android",
    )

    response = await db_client.get(f"{STAFF}/{ticket.id}", headers=world.agent.headers)

    assert response.status_code == 200, response.text
    detail = response.json()
    assert set(detail) == DETAIL_KEYS
    assert (detail["message"], detail["topic"], detail["role"]) == (MESSAGE, "safety", "pro")
    assert (detail["job_id"], detail["user_id"]) == (str(job.id), str(world.pro.id))
    assert (detail["app_version"], detail["platform"]) == (VERSION, "android")
    assert (detail["status"], detail["closed_at"]) == ("open", None)
    # Reading changes nothing and is not an audited action.
    assert await audit_rows(db_session) == []


async def test_an_unknown_ticket_is_404_and_a_bad_id_422(
    db_client: httpx.AsyncClient, world: JobWorld
) -> None:
    headers = world.admin.headers
    unknown, bad = f"{STAFF}/{uuid.uuid4()}", f"{STAFF}/not-a-uuid"

    responses = [
        await db_client.get(unknown, headers=headers),
        await db_client.patch(unknown, json={"status": "closed"}, headers=headers),
        await db_client.get(bad, headers=headers),
        await db_client.patch(bad, json={"status": "closed"}, headers=headers),
    ]

    assert [(r.status_code, r.json()) for r in responses] == [
        (404, NOT_FOUND),
        (404, NOT_FOUND),
        (422, VALIDATION_ERROR),
        (422, VALIDATION_ERROR),
    ]


# --- Staff: the status -----------------------------------------------------------------------


def status_change(actor: Party, ticket: SupportTicket, before: str, after: str) -> AuditRow:
    return AuditRow(
        actor_user_id=actor.id,
        action="support_ticket.set_status",
        entity_type="support_ticket",
        entity_id=ticket.id,
        before={"status": before},
        after={"status": after},
        reason=None,
    )


async def test_each_status_change_is_audited_with_its_actor(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    ticket = await seed(db_session, world.customer, age=timedelta(hours=1))
    path = f"{STAFF}/{ticket.id}"

    taken = await db_client.patch(path, json={"status": "in_progress"}, headers=world.agent.headers)
    closed = await db_client.patch(path, json={"status": "closed"}, headers=world.admin.headers)
    stored = await row(db_session, ticket.id)
    closed_at = stored.closed_at
    reopened = await db_client.patch(path, json={"status": "open"}, headers=world.agent.headers)

    assert [r.status_code for r in (taken, closed, reopened)] == [200, 200, 200]
    assert set(closed.json()) == DETAIL_KEYS
    assert (taken.json()["status"], taken.json()["closed_at"]) == ("in_progress", None)
    assert closed.json()["status"] == "closed"
    assert closed_at is not None
    assert closed_at >= stored.created_at
    assert closed.json()["message"] == MESSAGE
    # Reopened: closed_at is cleared with the status.
    assert (reopened.json()["status"], reopened.json()["closed_at"]) == ("open", None)
    stored = await row(db_session, ticket.id)
    assert (stored.status, stored.closed_at) == (TicketStatus.OPEN, None)
    assert stored.updated_at > stored.created_at
    # One row per change. The test runs in one transaction, so the three rows share one
    # created_at: compared in the order of the status they left.
    audited = sorted(await audit_rows(db_session), key=lambda change: str(change.before["status"]))
    assert audited == [
        status_change(world.agent, ticket, "closed", "open"),
        status_change(world.admin, ticket, "in_progress", "closed"),
        status_change(world.agent, ticket, "open", "in_progress"),
    ]


async def test_the_same_status_again_changes_and_audits_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    ticket = await seed(db_session, world.customer, status=TicketStatus.CLOSED)
    before = await row(db_session, ticket.id)
    stamps = (before.closed_at, before.updated_at)

    response = await db_client.patch(
        f"{STAFF}/{ticket.id}", json={"status": "closed"}, headers=world.agent.headers
    )

    assert (response.status_code, response.json()["status"]) == (200, "closed")
    after = await row(db_session, ticket.id)
    assert (after.closed_at, after.updated_at) == stamps
    assert await audit_rows(db_session) == []


@pytest.mark.parametrize(
    "data",
    [
        {"status": "archived"},
        {"status": None},
        {},
        {"status": "closed", "message": "edited"},
        {"status": "closed", "closed_at": "2020-01-01T00:00:00Z"},
    ],
    ids=["unknown", "null", "missing", "message", "closed_at"],
)
async def test_an_invalid_status_change_is_422_and_changes_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, data: dict[str, Any]
) -> None:
    ticket = await seed(db_session, world.customer)

    response = await db_client.patch(f"{STAFF}/{ticket.id}", json=data, headers=world.admin.headers)

    assert (response.status_code, response.json()) == (422, VALIDATION_ERROR)
    stored = await row(db_session, ticket.id)
    assert (stored.status, stored.message) == (TicketStatus.OPEN, MESSAGE)
    assert await audit_rows(db_session) == []


@pytest.mark.parametrize("failure", ["audit_write_fails", "audit_refuses_the_actor"])
async def test_a_change_that_cannot_be_audited_does_not_happen(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    ticket_id = (await seed(db_session, world.customer)).id
    await db_session.commit()  # the service's rollback must not take the fixtures with it

    if failure == "audit_write_fails":

        async def fail(self: AuditRepository, **fields: Any) -> None:
            raise RuntimeError("probe failure")

        monkeypatch.setattr(AuditRepository, "add", fail)
    else:
        # The refusal itself (who counts as active staff) is proven in test_audit_log.py; here,
        # what the route does with one: the change is rolled back and the answer is 403.

        async def refuse(self: AuditService, *args: Any) -> None:
            raise ActorNotStaffError

        monkeypatch.setattr(AuditService, "record_staff_action", refuse)

    response = await db_client.patch(
        f"{STAFF}/{ticket_id}", json={"status": "closed"}, headers=world.agent.headers
    )
    # What the request's own session does when it closes without a commit.
    await db_session.rollback()

    expected = 500 if failure == "audit_write_fails" else 403
    assert response.status_code == expected
    stored = await row(db_session, ticket_id)
    assert (stored.status, stored.closed_at) == (TicketStatus.OPEN, None)
    assert await db_session.scalar(select(func.count()).select_from(SupportTicket)) == 1
    assert await audit_rows(db_session) == []


# --- Logs and Sentry -------------------------------------------------------------------------


async def test_logs_carry_ids_only(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await make_job(db_session, world)
    staff = world.agent.headers

    with caplog.at_level(logging.DEBUG):
        created = await create(
            db_client, world.customer, job_id=str(job.id), app_version=VERSION, platform="ios"
        )
        ticket_id = created.json()["id"]
        refused = await create(db_client, world.customer, message=MESSAGE * 40)
        await db_client.get(MINE, headers=world.customer.headers)
        await db_client.get(STAFF, headers=staff)
        await db_client.get(f"{STAFF}/{ticket_id}", headers=staff)
        await db_client.patch(f"{STAFF}/{ticket_id}", json={"status": "closed"}, headers=staff)

    assert (created.status_code, refused.status_code) == (201, 422)
    [written] = [r for r in caplog.records if r.getMessage() == "support_ticket_created"]
    assert written.levelno == logging.INFO
    assert {
        key: written.__dict__[key] for key in ("ticket_id", "user_id", "role", "topic", "job_id")
    } == {
        "ticket_id": ticket_id,
        "user_id": str(world.customer.id),
        "role": "customer",
        "topic": "payment",
        "job_id": str(job.id),
    }
    [changed] = [r for r in caplog.records if r.getMessage() == "support_ticket_status_changed"]
    assert (changed.__dict__["from_status"], changed.__dict__["to_status"]) == ("open", "closed")
    assert changed.__dict__["staff_id"] == str(world.agent.id)
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]
    logs = "\n".join(JsonFormatter().format(r) + r.getMessage() for r in caplog.records)
    assert ticket_id in logs
    for leak in (*TEXT_LEAKS, CUSTOMER_FIRST):
        assert leak not in logs


async def test_a_failed_write_sends_no_text_to_sentry_or_the_logs(
    db_session: AsyncSession,
    world: JobWorld,
    sentry_transport: MemoryTransport,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    app = _app(make_settings(sentry_dsn=TEST_DSN), db_session)

    async def fail(self: SupportTicketRepository, ticket: SupportTicket) -> SupportTicket:
        raise RuntimeError("probe failure")

    monkeypatch.setattr(SupportTicketRepository, "add", fail)
    with caplog.at_level(logging.DEBUG):
        async with _client(app) as client:
            response = await create(client, world.customer, app_version=VERSION)
    sentry_sdk.flush()

    assert response.status_code == 500
    payloads = _payloads(sentry_transport)
    assert any('"exception"' in p for p in payloads), "no event was captured"
    wire = "\n".join(payloads)
    logs = "\n".join(JsonFormatter().format(r) + r.getMessage() for r in caplog.records)
    for leak in TEXT_LEAKS:
        assert leak not in response.text
        assert leak not in wire
        assert leak not in logs
