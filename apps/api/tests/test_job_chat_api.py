"""Job chat, part 1 (D14.1, #71): GET/POST /v1/jobs/{id}/messages, POST .../read, the staff
GET /v1/admin/jobs/{id}/messages, and the unread counts in the job views."""

import base64
import json
import logging
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
import sentry_sdk
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db import get_session
from app.main import create_app
from app.modules.chat.models import MESSAGE_MAX_LENGTH, JobChatRead, JobMessage
from app.modules.chat.repository import ChatRepository
from app.modules.jobs.models import Job, JobStatus
from app.observability import JsonFormatter
from app.rate_limit import get_rate_limiter
from app.redaction import MASK
from tests.conftest import InMemoryRateLimiter, make_settings
from tests.job_world import LEAKS, JobWorld, Party, build_world, make_job
from tests.test_sentry_scrubbing import TEST_DSN, MemoryTransport, _payloads

NOT_FOUND = {"error": {"code": "not_found", "message": "Resource not found."}}
FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}
CHAT_CLOSED = {"error": {"code": "chat_closed", "message": "This job's chat is closed."}}
INVALID_MESSAGE = {
    "error": {"code": "invalid_message", "message": "The message is not in this chat."}
}
VALIDATION = "validation_error"
OPEN = (
    JobStatus.SCHEDULED,
    JobStatus.ON_THE_WAY,
    JobStatus.IN_PROGRESS,
    JobStatus.COMPLETED,
    JobStatus.DISPUTED,
)
CLOSED = (JobStatus.CONFIRMED, JobStatus.PAID_OUT, JobStatus.REFUNDED, JobStatus.CANCELLED)
MESSAGE_KEYS = {"id", "sender", "body", "redacted", "created_at"}
# The POST answer adds the sender's warning (#72).
SENT_KEYS = MESSAGE_KEYS | {"warning"}
T0 = datetime(2030, 1, 15, 15, 0, tzinfo=UTC)
# Redaction samples (tests/test_redaction.py's kinds): what is typed, and what is stored.
REDACTED = [
    ("Call me at 305-555-0199 tomorrow", f"Call me at {MASK} tomorrow", "305-555-0199"),
    ("Write to jane.doe@gmail.com please", f"Write to {MASK} please", "jane.doe@gmail.com"),
    ("See www.example.com/quote for photos", f"See {MASK} for photos", "example.com"),
    (
        "Text me: three zero five five five five zero one nine nine",
        f"Text me: {MASK}",
        "three zero five",
    ),
]


def _b64(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


def messages_path(job_id: uuid.UUID) -> str:
    return f"/v1/jobs/{job_id}/messages"


def staff_path(job_id: uuid.UUID) -> str:
    return f"/v1/admin/jobs/{job_id}/messages"


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


async def seed(
    session: AsyncSession,
    job: Job,
    sender: Party,
    body: str = "hello",
    *,
    at: datetime | None = None,
    message_id: uuid.UUID | None = None,
) -> JobMessage:
    """A stored message; `at` and `message_id` place it exactly (ties, cursors)."""
    message = JobMessage(
        job_id=job.id,
        sender_id=sender.id,
        body=body,
        redacted=False,
        **({"created_at": at} if at else {}),
        **({"id": message_id} if message_id else {}),
    )
    session.add(message)
    await session.flush()
    return message


async def rows(session: AsyncSession, job: Job) -> list[JobMessage]:
    statement = (
        select(JobMessage)
        .where(JobMessage.job_id == job.id)
        .order_by(JobMessage.created_at, JobMessage.id)
        .execution_options(populate_existing=True)
    )
    return list((await session.scalars(statement)).all())


async def marker_count(session: AsyncSession) -> int:
    return int(await session.scalar(select(func.count()).select_from(JobChatRead)) or 0)


# Access: participants only, 404 for anyone else, the role gate first


async def _call(
    client: httpx.AsyncClient,
    endpoint: str,
    job_id: uuid.UUID,
    message_id: uuid.UUID,
    headers: dict[str, str] | None,
) -> httpx.Response:
    headers = headers or {}
    if endpoint == "list":
        return await client.get(messages_path(job_id), headers=headers)
    if endpoint == "send":
        return await client.post(messages_path(job_id), json={"body": "hi"}, headers=headers)
    if endpoint == "read":
        return await client.post(
            f"{messages_path(job_id)}/read", json={"up_to": str(message_id)}, headers=headers
        )
    return await client.get(staff_path(job_id), headers=headers)


ENDPOINTS = ("list", "send", "read", "staff")
EXPECTED = {
    "customer": (200, 201, 200, 403),
    "pro": (200, 201, 200, 403),
    "other_customer": (404, 404, 404, 403),
    "other_pro": (404, 404, 404, 403),
    "pro_without_profile": (404, 404, 404, 403),
    "agent": (403, 403, 403, 200),
    "admin": (403, 403, 403, 200),
}


@pytest.mark.parametrize("caller", sorted(EXPECTED))
async def test_every_endpoint_answers_by_caller(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, caller: str
) -> None:
    job = await make_job(db_session, world)
    first = await seed(db_session, job, world.pro, "first")
    headers = getattr(world, caller).headers

    for endpoint, expected in zip(ENDPOINTS, EXPECTED[caller], strict=True):
        response = await _call(db_client, endpoint, job.id, first.id, headers)
        assert response.status_code == expected, (endpoint, response.text)
        if expected == 404:
            assert response.json() == NOT_FOUND
        if expected == 403:
            assert response.json() == FORBIDDEN

    stored = await rows(db_session, job)
    wrote = caller in ("customer", "pro")
    assert len(stored) == (2 if wrote else 1)
    assert await marker_count(db_session) == (1 if wrote else 0)


async def test_unknown_job_reads_like_a_strangers(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    message = await seed(db_session, job, world.pro)
    unknown = uuid.uuid4()

    for endpoint in ("list", "send", "read"):
        response = await _call(db_client, endpoint, unknown, message.id, world.customer.headers)
        assert (response.status_code, response.json()) == (404, NOT_FOUND), endpoint
    response = await _call(db_client, "staff", unknown, message.id, world.admin.headers)
    assert (response.status_code, response.json()) == (404, NOT_FOUND)


async def test_unauthenticated_is_401(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    message = await seed(db_session, job, world.pro)

    for endpoint in ENDPOINTS:
        assert (await _call(db_client, endpoint, job.id, message.id, None)).status_code == 401


async def test_a_participant_of_one_job_is_a_stranger_to_another(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    # The pro's own job with the customer, and another pro's job with the same customer.
    mine = await make_job(db_session, world)
    theirs = await make_job(db_session, world, pro=world.other_pro)
    message = await seed(db_session, theirs, world.customer, "for the other pro")

    for endpoint in ("list", "send", "read"):
        response = await _call(db_client, endpoint, theirs.id, message.id, world.pro.headers)
        assert (response.status_code, response.json()) == (404, NOT_FOUND), endpoint
    # Their message id on my job's marker: not in this chat.
    response = await db_client.post(
        f"{messages_path(mine.id)}/read", json={"up_to": str(message.id)}, headers=world.pro.headers
    )
    assert (response.status_code, response.json()) == (422, INVALID_MESSAGE)
    assert await marker_count(db_session) == 0


# Sending: validation, redaction at write, the job's state


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"body": ""},
        {"body": "   \n\t "},
        {"body": "x" * (MESSAGE_MAX_LENGTH + 1)},
        {"body": "nul\x00byte"},
        {"body": 7},
        {"body": "hi", "sender": "pro"},
        # Nothing left once invisible characters are dropped (app.redaction cleans them).
        {"body": "​​"},
    ],
    ids=["missing", "empty", "blank", "too_long", "nul", "not_text", "extra_field", "invisible"],
)
async def test_bad_bodies_are_422_and_store_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    payload: dict[str, object],
) -> None:
    job = await make_job(db_session, world)

    response = await db_client.post(
        messages_path(job.id), json=payload, headers=world.customer.headers
    )

    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == VALIDATION
    assert await rows(db_session, job) == []


async def test_a_message_is_stored_trimmed_and_answered(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    longest = "y" * MESSAGE_MAX_LENGTH

    plain = await db_client.post(
        messages_path(job.id),
        json={"body": "  The faucet still drips at 7 pm \n"},
        headers=world.customer.headers,
    )
    full = await db_client.post(
        messages_path(job.id), json={"body": longest}, headers=world.pro.headers
    )

    assert plain.status_code == 201, plain.text
    body = plain.json()
    assert set(body) == SENT_KEYS
    assert (body["sender"], body["body"], body["redacted"], body["warning"]) == (
        "me",
        "The faucet still drips at 7 pm",
        False,
        None,
    )
    assert full.status_code == 201, full.text
    stored = await rows(db_session, job)
    assert [(m.sender_id, m.body, m.redacted) for m in stored] == [
        (world.customer.id, "The faucet still drips at 7 pm", False),
        (world.pro.id, longest, False),
    ]
    assert str(stored[0].id) == body["id"]
    assert datetime.fromisoformat(body["created_at"]) == stored[0].created_at


@pytest.mark.parametrize(("typed", "stored", "original"), REDACTED)
async def test_contacts_are_masked_at_write_and_never_stored(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    typed: str,
    stored: str,
    original: str,
) -> None:
    job = await make_job(db_session, world)

    response = await db_client.post(
        messages_path(job.id), json={"body": typed}, headers=world.pro.headers
    )

    assert response.status_code == 201, response.text
    assert (response.json()["body"], response.json()["redacted"]) == (stored, True)
    [message] = await rows(db_session, job)
    assert (message.body, message.redacted) == (stored, True)
    # The original exists nowhere in the database's chat tables.
    found = await db_session.scalar(
        select(func.count()).select_from(JobMessage).where(JobMessage.body.contains(original))
    )
    assert found == 0
    # And both sides read the masked text.
    for party in (world.customer, world.pro):
        listed = await db_client.get(messages_path(job.id), headers=party.headers)
        assert listed.json()["items"][0]["body"] == stored
        assert original not in listed.text


@pytest.mark.parametrize("status", OPEN)
async def test_open_jobs_take_messages(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, status: JobStatus
) -> None:
    job = await make_job(db_session, world, status)

    for party in (world.customer, world.pro):
        response = await db_client.post(
            messages_path(job.id), json={"body": "hi"}, headers=party.headers
        )
        assert response.status_code == 201, response.text


@pytest.mark.parametrize("status", CLOSED)
async def test_closed_jobs_are_read_only(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, status: JobStatus
) -> None:
    job = await make_job(db_session, world, status)
    earlier = await seed(db_session, job, world.pro, "before it closed")

    for party in (world.customer, world.pro):
        response = await db_client.post(
            messages_path(job.id), json={"body": "hi"}, headers=party.headers
        )
        assert (response.status_code, response.json()) == (409, CHAT_CLOSED)
        # Still readable, and the marker still moves.
        listed = await db_client.get(messages_path(job.id), headers=party.headers)
        assert [item["id"] for item in listed.json()["items"]] == [str(earlier.id)]
        read = await db_client.post(
            f"{messages_path(job.id)}/read", json={"up_to": str(earlier.id)}, headers=party.headers
        )
        assert read.status_code == 200, read.text
    assert [m.id for m in await rows(db_session, job)] == [earlier.id]


async def test_a_stranger_on_a_closed_job_still_gets_404(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world, JobStatus.CANCELLED)

    response = await db_client.post(
        messages_path(job.id), json={"body": "hi"}, headers=world.other_customer.headers
    )

    assert (response.status_code, response.json()) == (404, NOT_FOUND)


async def test_messages_in_one_transaction_keep_their_order(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    # The test's requests share one database transaction, so now() would tie them: created_at
    # comes from the clock under the job's lock, in the order the messages were written.
    job = await make_job(db_session, world)

    sent = []
    for index in range(3):
        response = await db_client.post(
            messages_path(job.id), json={"body": f"m{index}"}, headers=world.customer.headers
        )
        sent.append(response.json())

    times = [datetime.fromisoformat(item["created_at"]) for item in sent]
    assert times == sorted(times)
    assert len(set(times)) == 3
    listed = await db_client.get(messages_path(job.id), headers=world.pro.headers)
    assert [item["body"] for item in listed.json()["items"]] == ["m2", "m1", "m0"]


# Rate limit


@pytest.mark.parametrize("settings", [make_settings(chat_message_rate_limit=3)])
async def test_messages_are_rate_limited_per_user_per_job(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, settings: Settings
) -> None:
    job = await make_job(db_session, world)
    other_job = await make_job(db_session, world)

    def send(target: Job, party: Party) -> Any:
        return db_client.post(messages_path(target.id), json={"body": "hi"}, headers=party.headers)

    for _ in range(3):
        assert (await send(job, world.customer)).status_code == 201
    limited = await send(job, world.customer)

    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "rate_limited"
    assert 1 <= int(limited.headers["Retry-After"]) <= settings.chat_message_rate_window_seconds
    # Per user and per job: the pro, and the customer's other job, are not limited.
    assert (await send(job, world.pro)).status_code == 201
    assert (await send(other_job, world.customer)).status_code == 201
    assert len(await rows(db_session, job)) == 4


# Reading: order, cursor, unread


async def test_list_is_newest_first_with_ties_and_a_cursor(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    # Three messages share one timestamp: the id breaks the tie.
    tied_ids = sorted(uuid.uuid4() for _ in range(3))
    seeded = [await seed(db_session, job, world.customer, "old", at=T0)]
    for index, message_id in enumerate(tied_ids):
        seeded.append(
            await seed(
                db_session,
                job,
                world.pro,
                f"tie{index}",
                at=T0 + timedelta(minutes=1),
                message_id=message_id,
            )
        )
    seeded.append(await seed(db_session, job, world.customer, "new", at=T0 + timedelta(minutes=2)))
    expected = sorted(seeded, key=lambda m: (m.created_at, m.id), reverse=True)

    seen: list[str] = []
    cursor: str | None = None
    pages = 0
    while True:
        params: dict[str, str | int] = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        response = await db_client.get(
            messages_path(job.id), params=params, headers=world.customer.headers
        )
        assert response.status_code == 200, response.text
        page = response.json()
        assert set(page) == {"items", "next_cursor", "unread_count"}
        assert len(page["items"]) <= 2
        seen += [item["id"] for item in page["items"]]
        pages += 1
        cursor = page["next_cursor"]
        if cursor is None:
            break

    assert seen == [str(m.id) for m in expected]
    assert pages == 3
    items = (await db_client.get(messages_path(job.id), headers=world.customer.headers)).json()
    senders = {item["id"]: item["sender"] for item in items["items"]}
    assert senders[str(seeded[0].id)] == "me"
    assert senders[str(tied_ids[0])] == "pro"
    for item in items["items"]:
        assert set(item) == MESSAGE_KEYS


@pytest.mark.parametrize(
    "cursor",
    [
        "not-base64!",
        _b64("not a cursor"),
        _b64("2030-01-15T15:00:00+00:00|not-a-uuid"),
        _b64(f"2030-01-15T15:00:00|{uuid.UUID(int=1)}"),
    ],
    ids=["garbage", "no_separator", "bad_id", "naive_time"],
)
async def test_a_tampered_cursor_is_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, cursor: str
) -> None:
    job = await make_job(db_session, world)

    response = await db_client.get(
        messages_path(job.id), params={"cursor": cursor}, headers=world.customer.headers
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == VALIDATION


async def test_a_cursor_never_leaves_the_job(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    mine = await make_job(db_session, world)
    other = await make_job(db_session, world, pro=world.other_pro)
    await seed(db_session, other, world.other_pro, "other pro's chat", at=T0)
    await seed(db_session, other, world.other_pro, "other pro's newer", at=T0 + timedelta(1))
    await seed(db_session, mine, world.pro, "mine", at=T0)
    # A cursor taken from the other job's thread, used on mine.
    page = await db_client.get(
        messages_path(other.id), params={"limit": 1}, headers=world.customer.headers
    )
    cursor = page.json()["next_cursor"]
    assert cursor

    response = await db_client.get(
        messages_path(mine.id), params={"cursor": cursor}, headers=world.pro.headers
    )

    assert response.status_code == 200
    assert [item["body"] for item in response.json()["items"]] == ["mine"]


async def test_read_marker_moves_forward_only_and_is_idempotent(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    first = await seed(db_session, job, world.pro, "1", at=T0)
    second = await seed(db_session, job, world.pro, "2", at=T0 + timedelta(minutes=1))
    third = await seed(db_session, job, world.pro, "3", at=T0 + timedelta(minutes=2))
    await seed(db_session, job, world.customer, "own", at=T0 + timedelta(minutes=3))
    read = f"{messages_path(job.id)}/read"

    async def mark(message: JobMessage) -> int:
        response = await db_client.post(
            read, json={"up_to": str(message.id)}, headers=world.customer.headers
        )
        assert response.status_code == 200, response.text
        assert set(response.json()) == {"unread_count"}
        return int(response.json()["unread_count"])

    async def unread() -> int:
        listed = await db_client.get(messages_path(job.id), headers=world.customer.headers)
        return int(listed.json()["unread_count"])

    # The customer's own message never counts.
    assert await unread() == 3
    assert await mark(second) == 1
    assert await mark(second) == 1  # idempotent
    assert await mark(first) == 1  # never back
    assert await unread() == 1
    assert await mark(third) == 0
    [marker] = (await db_session.scalars(select(JobChatRead))).all()
    await db_session.refresh(marker)
    assert (marker.user_id, marker.last_read_message_id) == (world.customer.id, third.id)
    # The pro's count is their own: nothing of the customer's marker.
    pro_view = await db_client.get(messages_path(job.id), headers=world.pro.headers)
    assert pro_view.json()["unread_count"] == 1


async def test_read_marker_tie_break_on_the_id(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    low, high = sorted(uuid.uuid4() for _ in range(2))
    await seed(db_session, job, world.pro, "low", at=T0, message_id=low)
    await seed(db_session, job, world.pro, "high", at=T0, message_id=high)
    read = f"{messages_path(job.id)}/read"

    first = await db_client.post(read, json={"up_to": str(low)}, headers=world.customer.headers)
    back = await db_client.post(read, json={"up_to": str(high)}, headers=world.customer.headers)
    again = await db_client.post(read, json={"up_to": str(low)}, headers=world.customer.headers)

    assert [r.json()["unread_count"] for r in (first, back, again)] == [1, 0, 0]


@pytest.mark.parametrize(
    "payload",
    [{}, {"up_to": "nope"}, {"up_to": str(uuid.UUID(int=0)), "extra": 1}],
    ids=["missing", "not_uuid", "extra_field"],
)
async def test_bad_read_bodies_are_422(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    payload: dict[str, object],
) -> None:
    job = await make_job(db_session, world)

    response = await db_client.post(
        f"{messages_path(job.id)}/read", json=payload, headers=world.customer.headers
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == VALIDATION


async def test_read_of_an_unknown_message_is_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)

    response = await db_client.post(
        f"{messages_path(job.id)}/read",
        json={"up_to": str(uuid.uuid4())},
        headers=world.customer.headers,
    )

    assert (response.status_code, response.json()) == (422, INVALID_MESSAGE)


# Unread counts in the job views (#63's)


async def test_job_views_show_the_callers_unread_count(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    quiet = await make_job(db_session, world)
    await seed(db_session, job, world.pro, "p1", at=T0)
    newest_from_pro = await seed(db_session, job, world.pro, "p2", at=T0 + timedelta(minutes=1))
    await seed(db_session, job, world.customer, "c1", at=T0 + timedelta(minutes=2))
    customer_view = f"/v1/requests/{job.request_id}/job"
    pro_view = f"/v1/pros/me/jobs/{job.id}"

    async def counts() -> tuple[int, int, dict[str, int]]:
        customer = await db_client.get(customer_view, headers=world.customer.headers)
        pro = await db_client.get(pro_view, headers=world.pro.headers)
        listed = await db_client.get("/v1/pros/me/jobs", headers=world.pro.headers)
        assert customer.status_code == pro.status_code == listed.status_code == 200
        return (
            customer.json()["unread_messages"],
            pro.json()["unread_messages"],
            {item["id"]: item["unread_messages"] for item in listed.json()["items"]},
        )

    assert await counts() == (2, 1, {str(job.id): 1, str(quiet.id): 0})
    await db_client.post(
        f"{messages_path(job.id)}/read",
        json={"up_to": str(newest_from_pro.id)},
        headers=world.customer.headers,
    )
    assert await counts() == (0, 1, {str(job.id): 1, str(quiet.id): 0})
    # A staff read moves no marker.
    staff = await db_client.get(staff_path(job.id), headers=world.agent.headers)
    assert staff.status_code == 200
    assert await counts() == (0, 1, {str(job.id): 1, str(quiet.id): 0})
    assert await marker_count(db_session) == 1


# Staff


async def test_staff_read_names_sides_only(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world, JobStatus.DISPUTED)
    await seed(db_session, job, world.customer, "from the customer", at=T0)
    await seed(db_session, job, world.pro, "from the pro", at=T0 + timedelta(minutes=1))

    response = await db_client.get(
        staff_path(job.id), params={"limit": 1}, headers=world.admin.headers
    )

    assert response.status_code == 200, response.text
    page = response.json()
    assert set(page) == {"items", "next_cursor"}
    assert [(i["sender"], i["body"]) for i in page["items"]] == [("pro", "from the pro")]
    rest = await db_client.get(
        staff_path(job.id), params={"cursor": page["next_cursor"]}, headers=world.admin.headers
    )
    assert [(i["sender"], i["body"]) for i in rest.json()["items"]] == [
        ("customer", "from the customer")
    ]
    for text in (response.text, rest.text):
        assert str(world.customer.id) not in text
        assert str(world.pro.id) not in text
        for leak in LEAKS:
            assert leak not in text


async def test_responses_never_carry_ids_or_contacts_of_the_parties(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    await seed(db_session, job, world.pro, "hello")
    sent = await db_client.post(
        messages_path(job.id), json={"body": "hi there"}, headers=world.customer.headers
    )

    for party in (world.customer, world.pro):
        listed = await db_client.get(messages_path(job.id), headers=party.headers)
        for text in (listed.text, sent.text):
            assert str(world.customer.id) not in text
            assert str(world.pro.id) not in text
            assert str(world.pro.profile_id) not in text
            for leak in LEAKS:
                assert leak not in text


# Never a body in the logs or in Sentry

SECRET_PHRASE = "the spare key is under the blue flowerpot"


async def test_logs_carry_ids_never_the_body(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await make_job(db_session, world)
    typed = f"{SECRET_PHRASE}, call 305-555-0199"

    with caplog.at_level(logging.DEBUG):
        response = await db_client.post(
            messages_path(job.id), json={"body": typed}, headers=world.pro.headers
        )
        await db_client.get(messages_path(job.id), headers=world.customer.headers)
        await db_client.get(staff_path(job.id), headers=world.admin.headers)

    assert response.status_code == 201
    [sent] = [r for r in caplog.records if r.getMessage() == "job_message_sent"]
    fields: dict[str, Any] = sent.__dict__
    assert fields["job_id"] == str(job.id)
    assert fields["message_id"] == response.json()["id"]
    assert (fields["sender"], fields["redacted"]) == ("pro", True)
    assert fields["length"] == len(response.json()["body"])
    formatter = JsonFormatter()
    logs = "\n".join(formatter.format(r) + r.getMessage() for r in caplog.records)
    for leak in (SECRET_PHRASE, "flowerpot", "305-555-0199", MASK):
        assert leak not in logs


@pytest.fixture
def sentry_transport(monkeypatch: pytest.MonkeyPatch) -> Iterator[MemoryTransport]:
    transport = MemoryTransport()
    real_init = sentry_sdk.init

    def init_with_memory_transport(*args: Any, **kwargs: Any) -> object:
        return real_init(*args, transport=transport, **kwargs)

    monkeypatch.setattr(sentry_sdk, "init", init_with_memory_transport)
    try:
        yield transport
    finally:
        sentry_sdk.get_client().close()
        sentry_sdk.get_global_scope().set_client(None)


async def test_a_failed_send_reaches_sentry_without_the_body(
    db_session: AsyncSession,
    world: JobWorld,
    sentry_transport: MemoryTransport,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job = await make_job(db_session, world)
    app: FastAPI = create_app(make_settings(sentry_dsn=TEST_DSN))
    limiter = InMemoryRateLimiter()
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    app.state.rolled_back_session = db_session

    async def session_override() -> Any:
        yield db_session

    app.dependency_overrides[get_session] = session_override

    async def fail(self: ChatRepository, message: JobMessage) -> JobMessage:
        raise RuntimeError("probe failure")

    monkeypatch.setattr(ChatRepository, "add", fail)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            messages_path(job.id),
            json={"body": f"{SECRET_PHRASE} jane.doe@gmail.com"},
            headers=world.customer.headers,
        )
    sentry_sdk.flush()

    assert response.status_code == 500
    payloads = _payloads(sentry_transport)
    events = [json.loads(p) for p in payloads if '"exception"' in p]
    assert events, "no event was captured"
    wire = "\n".join(payloads)
    for leak in (SECRET_PHRASE, "flowerpot", "jane.doe@gmail.com", MASK):
        assert leak not in wire


async def test_a_stranger_gets_404_before_any_redaction(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job = await make_job(db_session, world)
    calls: list[str] = []
    monkeypatch.setattr("app.modules.chat.service.redact_contacts", lambda text: calls.append(text))

    for job_id in (job.id, uuid.uuid4()):
        response = await db_client.post(
            messages_path(job_id), json={"body": "x" * 2000}, headers=world.other_pro.headers
        )
        assert (response.status_code, response.json()) == (404, NOT_FOUND)
    assert calls == []
