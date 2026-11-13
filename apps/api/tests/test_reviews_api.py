"""Two-sided reviews (#77): POST /v1/jobs/{job_id}/reviews, GET .../reviews/mine and
GET /v1/users/me/rating."""

import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import httpx
import pytest
import sentry_sdk
from fastapi import FastAPI
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.confirmation import JobAutoConfirmer
from app.modules.jobs.models import Job, JobStatus
from app.modules.jobs.service import SYSTEM, JobStateMachine, is_reviewable
from app.modules.jobs.transitions import REVIEWABLE, TRANSITIONS
from app.modules.pros.service import ProService
from app.modules.reviews.models import Review, ReviewAuthorRole
from app.modules.reviews.repository import ReviewRepository
from app.modules.reviews.router import get_review_clock
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount
from app.observability import JsonFormatter
from app.rate_limit import get_rate_limiter
from app.redaction import MASK
from tests.conftest import InMemoryRateLimiter, make_settings
from tests.job_world import LEAKS, LINE1, JobWorld, Party, Pro, build_world, make_job, record_pushes
from tests.test_chat_originals import _app, _client
from tests.test_sentry_scrubbing import TEST_DSN, MemoryTransport, _payloads, sentry_transport

__all__ = ["sentry_transport"]  # a fixture, used by name

RATING = "/v1/users/me/rating"
# Distinctive on purpose: none of them can show up inside a UUID, a timestamp or a count.
PHONE: Final = "(786) 555-0142"
EMAIL: Final = "reach.me.zq77@example.com"
SENTINEL: Final = "zqxj-review-sentinel"
COMMENT: Final = f"Great work {SENTINEL}. Call me at {PHONE} or write to {EMAIL}"
TEXT_LEAKS = (SENTINEL, PHONE, EMAIL, *LEAKS)
NOW = 1_800_000_000.0  # a fixed clock, so no test straddles two rate-limit windows

VALIDATION_ERROR = {"error": {"code": "validation_error", "message": "The request is invalid."}}
NOT_FOUND = {"error": {"code": "not_found", "message": "Resource not found."}}
FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}
NOT_REVIEWABLE = {
    "error": {"code": "job_not_reviewable", "message": "This job cannot be reviewed."}
}
ALREADY_REVIEWED = {
    "error": {"code": "already_reviewed", "message": "You already reviewed this job."}
}
RATE_LIMITED = {"error": {"code": "rate_limited", "message": "Too many requests. Try again later."}}
CREATED_KEYS = {"id", "created_at", "comment_redacted"}
REVIEW_KEYS = {
    "id",
    "overall",
    "communication",
    "quality",
    "punctuality",
    "value",
    "comment",
    "created_at",
}
# Every status a job can have without a confirmation. With REVIEWABLE they are all of them, so
# a new status has to pick a side (test_every_status_is_reviewable_or_not).
NEVER_CONFIRMED = [
    JobStatus.SCHEDULED,
    JobStatus.ON_THE_WAY,
    JobStatus.IN_PROGRESS,
    JobStatus.COMPLETED,
    JobStatus.DISPUTED,
    JobStatus.REFUNDED,
    JobStatus.CANCELLED,
]


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


def path(job_id: object) -> str:
    return f"/v1/jobs/{job_id}/reviews"


def mine_path(job_id: object) -> str:
    return f"/v1/jobs/{job_id}/reviews/mine"


async def confirmed_job(
    session: AsyncSession, world: JobWorld, *, pro: Pro | None = None, **fields: Any
) -> Job:
    """A job the customer confirmed an hour ago."""
    now = datetime.now(UTC)
    values: dict[str, Any] = {
        "completed_at": now - timedelta(hours=5),
        "confirmed_at": now - timedelta(hours=1),
        **fields,
    }
    return await make_job(session, world, JobStatus.CONFIRMED, pro=pro, **values)


async def post(
    client: httpx.AsyncClient, party: Party, job_id: object, /, **body: Any
) -> httpx.Response:
    body.setdefault("overall", 5)
    return await client.post(path(job_id), json=body, headers=party.headers)


async def mine(client: httpx.AsyncClient, party: Party, job_id: object) -> httpx.Response:
    return await client.get(mine_path(job_id), headers=party.headers)


async def rating(client: httpx.AsyncClient, party: Party) -> dict[str, Any]:
    response = await client.get(RATING, headers=party.headers)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def rows(session: AsyncSession) -> list[Review]:
    statement = (
        select(Review)
        .order_by(Review.created_at, Review.id)
        .execution_options(populate_existing=True)
    )
    return list((await session.scalars(statement)).all())


async def seed(
    session: AsyncSession, job: Job, author: Party, target: Party, overall: int, **fields: Any
) -> Review:
    """A review written straight to the table."""
    role = ReviewAuthorRole.PRO if isinstance(author, Pro) else ReviewAuthorRole.CUSTOMER
    review = Review(
        job_id=job.id,
        author_id=author.id,
        target_id=target.id,
        author_role=role,
        overall=overall,
        **fields,
    )
    session.add(review)
    await session.flush()
    return review


async def account(session: AsyncSession, party: Party) -> UserAccount:
    found = await UserService(session).get_by_id(party.id)
    assert found is not None
    return found


# --- Writing a review ------------------------------------------------------------------------


async def test_a_customer_reviews_the_pro_on_every_dimension(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await confirmed_job(db_session, world)

    response = await post(
        db_client,
        world.customer,
        job.id,
        overall=4,
        communication=5,
        quality=3,
        punctuality=2,
        value=1,
        comment="  Fixed the faucet in one visit.\n",
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert set(body) == CREATED_KEYS
    assert body["comment_redacted"] is False
    [review] = await rows(db_session)
    assert (str(review.id), review.created_at) == (
        body["id"],
        datetime.fromisoformat(body["created_at"]),
    )
    assert (review.job_id, review.author_id, review.author_role) == (
        job.id,
        world.customer.id,
        ReviewAuthorRole.CUSTOMER,
    )
    # The pro's user, not their profile: the counterpart on this job.
    assert review.target_id == world.pro.id
    assert (
        review.overall,
        review.communication,
        review.quality,
        review.punctuality,
        review.value,
    ) == (4, 5, 3, 2, 1)
    assert review.comment == "Fixed the faucet in one visit."


async def test_a_pro_reviews_the_customer_on_their_three_dimensions(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await confirmed_job(db_session, world)

    response = await post(
        db_client, world.pro, job.id, overall=5, communication=4, punctuality=3, comment="Kind."
    )

    assert response.status_code == 201, response.text
    [review] = await rows(db_session)
    assert (review.author_id, review.target_id, review.author_role) == (
        world.pro.id,
        world.customer.id,
        ReviewAuthorRole.PRO,
    )
    assert (review.overall, review.communication, review.punctuality) == (5, 4, 3)
    assert (review.quality, review.value, review.comment) == (None, None, "Kind.")


@pytest.mark.parametrize("side", ["customer", "pro"])
async def test_overall_alone_is_a_review(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, side: str
) -> None:
    job = await confirmed_job(db_session, world)

    response = await db_client.post(
        path(job.id), json={"overall": 1}, headers=getattr(world, side).headers
    )

    assert response.status_code == 201, response.text
    assert response.json()["comment_redacted"] is False
    [review] = await rows(db_session)
    assert review.overall == 1
    assert (
        review.communication,
        review.quality,
        review.punctuality,
        review.value,
        review.comment,
    ) == (None,) * 5


@pytest.mark.parametrize(
    "extra",
    ["target_id", "author_id", "author_role", "job_id", "id", "created_at", "photos"],
)
async def test_the_target_and_the_author_never_come_from_the_body(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, extra: str
) -> None:
    job = await confirmed_job(db_session, world)
    values = {
        "target_id": str(world.other_pro.id),
        "author_id": str(world.other_customer.id),
        "author_role": "pro",
        "job_id": str(uuid.uuid4()),
        "id": str(uuid.uuid4()),
        "created_at": "2020-01-01T00:00:00Z",
        "photos": [],
    }

    response = await post(db_client, world.customer, job.id, **{extra: values[extra]})

    assert (response.status_code, response.json()) == (422, VALIDATION_ERROR)
    assert await rows(db_session) == []


async def test_each_side_is_reviewed_by_its_own_counterpart_on_that_job(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    # The same customer with two pros: each review goes to the pro of its own job.
    first = await confirmed_job(db_session, world)
    second = await confirmed_job(db_session, world, pro=world.other_pro)

    for job in (first, second):
        assert (await post(db_client, world.customer, job.id)).status_code == 201
    assert (await post(db_client, world.other_pro, second.id)).status_code == 201

    assert {(r.job_id, r.author_id, r.target_id) for r in await rows(db_session)} == {
        (first.id, world.customer.id, world.pro.id),
        (second.id, world.customer.id, world.other_pro.id),
        (second.id, world.other_pro.id, world.customer.id),
    }


# --- Who may review ---------------------------------------------------------------------------


@pytest.mark.parametrize("who", ["other_customer", "other_pro", "pro_without_profile"])
@pytest.mark.parametrize("status", [JobStatus.CONFIRMED, JobStatus.SCHEDULED])
async def test_a_job_of_others_answers_like_an_unknown_one(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    who: str,
    status: JobStatus,
) -> None:
    job = await make_job(db_session, world, status)
    stranger: Party = getattr(world, who)
    unknown = uuid.uuid4()

    answers = {
        (target, method): await db_client.request(
            method, url(target), json={"overall": 5, "comment": COMMENT}, headers=stranger.headers
        )
        for target in (job.id, unknown)
        for method, url in (("POST", path), ("GET", mine_path))
    }

    # A stranger learns neither that the job exists nor what state it is in.
    for response in answers.values():
        assert (response.status_code, response.json()) == (404, NOT_FOUND)
    for method in ("POST", "GET"):
        theirs, missing = answers[job.id, method], answers[unknown, method]
        assert theirs.content == missing.content
        assert theirs.headers["content-type"] == missing.headers["content-type"]
    assert await rows(db_session) == []


@pytest.mark.parametrize("staff", ["agent", "admin"])
async def test_staff_neither_review_nor_have_a_rating(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, staff: str
) -> None:
    job = await confirmed_job(db_session, world)
    party: Party = getattr(world, staff)

    answers = [
        await post(db_client, party, job.id),
        await mine(db_client, party, job.id),
        await db_client.get(RATING, headers=party.headers),
    ]

    assert [(r.status_code, r.json()) for r in answers] == [(403, FORBIDDEN)] * 3
    assert await rows(db_session) == []


@pytest.mark.parametrize(
    ("method", "url"),
    [("POST", path(uuid.uuid4())), ("GET", mine_path(uuid.uuid4())), ("GET", RATING)],
)
async def test_no_token_is_401(
    db_client: httpx.AsyncClient, db_session: AsyncSession, method: str, url: str
) -> None:
    response = await db_client.request(method, url, json={"overall": 5})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_token"
    assert await rows(db_session) == []


async def test_nobody_reviews_themselves(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    # A job whose customer is also its pro's user: no route creates one, the rule holds anyway.
    job = await confirmed_job(db_session, world)
    job.customer_id = world.pro.id
    await db_session.flush()

    response = await post(db_client, world.pro, job.id)
    state = await mine(db_client, world.pro, job.id)

    assert (response.status_code, response.json()) == (409, NOT_REVIEWABLE)
    assert state.json() == {"review": None, "can_review": False}
    assert await rows(db_session) == []


# --- Only once the job was confirmed ---------------------------------------------------------


def test_every_status_is_reviewable_or_not() -> None:
    assert frozenset({JobStatus.CONFIRMED, JobStatus.PAID_OUT}) == REVIEWABLE
    assert set(NEVER_CONFIRMED) | REVIEWABLE == set(JobStatus)
    assert not set(NEVER_CONFIRMED) & REVIEWABLE


def test_a_reviewable_job_stays_reviewable() -> None:
    # No lock is taken on the job: nothing leads from a reviewable status to another one.
    leaving = {to for (source, to) in TRANSITIONS if source in REVIEWABLE}

    assert leaving == {JobStatus.PAID_OUT}
    # The only way into confirmed sets confirmed_at; a dispute never passes through it.
    assert {source for (source, to) in TRANSITIONS if to is JobStatus.CONFIRMED} == {
        JobStatus.COMPLETED
    }
    assert not any(
        source is JobStatus.CONFIRMED and to is JobStatus.DISPUTED for source, to in TRANSITIONS
    )


@pytest.mark.parametrize(
    ("status", "confirmed", "expected"),
    [
        (JobStatus.CONFIRMED, True, True),
        (JobStatus.PAID_OUT, True, True),
        # Paid out by an admin's release of a dispute: never confirmed.
        (JobStatus.PAID_OUT, False, False),
        *((status, False, False) for status in NEVER_CONFIRMED),
        # A timestamp alone never makes a job reviewable.
        *((status, True, False) for status in NEVER_CONFIRMED),
    ],
)
def test_is_reviewable(status: JobStatus, confirmed: bool, expected: bool) -> None:
    job = Job(status=status, confirmed_at=datetime.now(UTC) if confirmed else None)

    assert is_reviewable(job) is expected


@pytest.mark.parametrize("side", ["customer", "pro"])
@pytest.mark.parametrize(
    ("status", "confirmed"),
    [
        *((status, False) for status in NEVER_CONFIRMED),
        # Paid out by an admin's release of a dispute: never confirmed.
        (JobStatus.PAID_OUT, False),
        # A timestamp alone never makes a job reviewable.
        *((status, True) for status in NEVER_CONFIRMED),
    ],
    ids=lambda value: value.value if isinstance(value, JobStatus) else f"confirmed_at={value}",
)
async def test_a_job_that_was_not_confirmed_is_not_reviewable(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    side: str,
    status: JobStatus,
    confirmed: bool,
) -> None:
    confirmed_at = datetime.now(UTC) if confirmed else None
    job = await make_job(db_session, world, status, confirmed_at=confirmed_at)
    party: Party = getattr(world, side)

    response = await post(db_client, party, job.id, comment=COMMENT)
    state = await mine(db_client, party, job.id)

    assert (response.status_code, response.json()) == (409, NOT_REVIEWABLE)
    assert (state.status_code, state.json()) == (200, {"review": None, "can_review": False})
    assert await rows(db_session) == []


@pytest.mark.parametrize("side", ["customer", "pro"])
@pytest.mark.parametrize("status", [JobStatus.CONFIRMED, JobStatus.PAID_OUT])
async def test_a_confirmed_job_is_reviewable_before_and_after_the_payout(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    side: str,
    status: JobStatus,
) -> None:
    job = await make_job(db_session, world, status, confirmed_at=datetime.now(UTC))
    party: Party = getattr(world, side)

    before = await mine(db_client, party, job.id)
    response = await post(db_client, party, job.id)

    assert before.json() == {"review": None, "can_review": True}
    assert response.status_code == 201, response.text
    assert [r.author_id for r in await rows(db_session)] == [party.id]


async def test_the_customers_confirmation_opens_the_reviews_and_the_payout_keeps_them_open(
    app: FastAPI, db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    record_pushes(app)
    job = await make_job(
        db_session,
        world,
        JobStatus.COMPLETED,
        completed_at=datetime.now(UTC) - timedelta(hours=3),
    )

    early = await post(db_client, world.customer, job.id)
    confirm = await db_client.post(
        f"/v1/requests/{job.request_id}/job/confirm", headers=world.customer.headers
    )
    by_customer = await post(db_client, world.customer, job.id)
    # The transfer worker (#68) pays the confirmed job out, as the system.
    machine = JobStateMachine(db_session, ProService(db_session))
    assert await machine.transition(job.id, JobStatus.PAID_OUT, SYSTEM) is JobStatus.PAID_OUT
    by_pro = await post(db_client, world.pro, job.id)

    assert (early.status_code, early.json()) == (409, NOT_REVIEWABLE)
    assert confirm.status_code == 200, confirm.text
    assert (by_customer.status_code, by_pro.status_code) == (201, 201)
    # One transaction shares now(), so the two rows come in either order.
    assert {r.author_id for r in await rows(db_session)} == {world.customer.id, world.pro.id}


async def test_the_auto_confirm_opens_the_reviews(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    now = datetime.now(UTC)
    job = await make_job(
        db_session, world, JobStatus.COMPLETED, completed_at=now - timedelta(hours=49)
    )

    early = await post(db_client, world.pro, job.id)
    confirmed = await JobAutoConfirmer(db_session).confirm_if_due(job.id, now - timedelta(hours=48))
    answers = [await post(db_client, party, job.id) for party in (world.pro, world.customer)]

    assert (early.status_code, early.json()) == (409, NOT_REVIEWABLE)
    assert confirmed is not None
    assert [r.status_code for r in answers] == [201, 201]


async def test_a_dispute_released_by_an_admin_is_not_reviewable(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(
        db_session, world, JobStatus.COMPLETED, completed_at=datetime.now(UTC) - timedelta(hours=3)
    )
    machine = JobStateMachine(db_session, ProService(db_session))
    await machine.transition(job.id, JobStatus.DISPUTED, await account(db_session, world.customer))
    await machine.transition(job.id, JobStatus.PAID_OUT, await account(db_session, world.admin))

    answers = [await post(db_client, party, job.id) for party in (world.customer, world.pro)]

    assert [(r.status_code, r.json()) for r in answers] == [(409, NOT_REVIEWABLE)] * 2
    assert await rows(db_session) == []


# --- One review per side per job -------------------------------------------------------------


@pytest.mark.parametrize("side", ["customer", "pro"])
async def test_a_second_review_by_the_same_side_is_409_and_changes_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, side: str
) -> None:
    job = await confirmed_job(db_session, world)
    party: Party = getattr(world, side)
    first = await post(db_client, party, job.id, overall=4, comment="The first one.")

    again = await post(db_client, party, job.id, overall=1, comment="The second one.")
    same = await post(db_client, party, job.id, overall=4, comment="The first one.")

    assert first.status_code == 201, first.text
    for response in (again, same):
        assert (response.status_code, response.json()) == (409, ALREADY_REVIEWED)
    [review] = await rows(db_session)
    assert (str(review.id), review.overall, review.comment) == (
        first.json()["id"],
        4,
        "The first one.",
    )
    assert review.created_at == review.updated_at


async def test_each_side_reviews_once_and_another_job_is_another_review(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job, other_job = [await confirmed_job(db_session, world) for _ in range(2)]

    statuses = [
        (await post(db_client, world.customer, job.id)).status_code,
        (await post(db_client, world.pro, job.id)).status_code,
        (await post(db_client, world.customer, other_job.id)).status_code,
        (await post(db_client, world.customer, job.id)).status_code,
        (await post(db_client, world.pro, job.id)).status_code,
    ]

    assert statuses == [201, 201, 201, 409, 409]
    assert sorted((r.job_id, r.author_id) for r in await rows(db_session)) == sorted(
        [
            (job.id, world.customer.id),
            (job.id, world.pro.id),
            (other_job.id, world.customer.id),
        ]
    )


# --- What a review may hold ------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad",
    [
        {"overall": None},
        {"overall": 0},
        {"overall": 6},
        {"overall": -1},
        {"overall": "5"},
        {"overall": 4.0},
        {"overall": 4.5},
        {"overall": True},
        {"overall": [5]},
        *(
            {name: value}
            for name in ("communication", "quality", "punctuality", "value")
            for value in (0, 6, "3", 2.0, False)
        ),
        {"comment": ""},
        {"comment": "   \n\t "},
        {"comment": "x" * 1001},
        {"comment": "null\x00byte"},
        {"comment": 5},
        {"comment": ["a"]},
        # Nothing visible: zero-width spaces only.
        {"comment": chr(0x200B) * 3},
        {"rating": 5},
    ],
    ids=lambda bad: "+".join(f"{key}={str(value)[:10]!r}" for key, value in bad.items()),
)
async def test_an_invalid_review_is_422_and_stores_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, bad: dict[str, Any]
) -> None:
    job = await confirmed_job(db_session, world)

    response = await db_client.post(
        path(job.id), json={"overall": 5} | bad, headers=world.customer.headers
    )

    assert (response.status_code, response.json()) == (422, VALIDATION_ERROR)
    assert await rows(db_session) == []


async def test_a_review_needs_an_overall_rating(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await confirmed_job(db_session, world)
    # No overall, no object, no body at all.
    bodies: list[Any] = [{}, {"communication": 5, "comment": "Fine."}, [], None]

    answers = [
        await db_client.post(path(job.id), json=body, headers=world.customer.headers)
        for body in bodies
    ]

    assert [(r.status_code, r.json()) for r in answers] == [(422, VALIDATION_ERROR)] * 4
    assert await rows(db_session) == []


@pytest.mark.parametrize("dimension", ["quality", "value"])
async def test_a_pro_may_not_rate_what_only_the_customer_rates(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, dimension: str
) -> None:
    job = await confirmed_job(db_session, world)

    refused = await post(db_client, world.pro, job.id, **{dimension: 5})
    # The customer of the same job may; and the pro without it.
    by_customer = await post(db_client, world.customer, job.id, **{dimension: 5})
    by_pro = await post(db_client, world.pro, job.id, communication=5, punctuality=5)

    assert (refused.status_code, refused.json()) == (422, VALIDATION_ERROR)
    assert (by_customer.status_code, by_pro.status_code) == (201, 201)
    assert {r.author_role: getattr(r, dimension) for r in await rows(db_session)} == {
        ReviewAuthorRole.CUSTOMER: 5,
        ReviewAuthorRole.PRO: None,
    }


async def test_the_longest_comment_is_accepted(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await confirmed_job(db_session, world)

    response = await post(db_client, world.customer, job.id, comment="é" * 1000)

    assert response.status_code == 201, response.text
    assert [len(r.comment or "") for r in await rows(db_session)] == [1000]


async def test_text_with_no_utf8_form_is_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await confirmed_job(db_session, world)
    body = {"overall": 5, "comment": "lone " + chr(0xD83D)}

    # Serialized here: httpx refuses lone surrogates, a raw client does not.
    response = await db_client.post(
        path(job.id),
        content=json.dumps(body),
        headers={**world.customer.headers, "Content-Type": "application/json"},
    )

    assert (response.status_code, response.json()) == (422, VALIDATION_ERROR)
    assert await rows(db_session) == []


async def test_a_comment_that_outgrows_the_limit_once_masked_is_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await confirmed_job(db_session, world)
    # 1000 characters as typed; the 2-character handle becomes the 3-character mask.
    typed = "x" * 997 + " @a"

    refused = await post(db_client, world.customer, job.id, comment=typed)
    fits = await post(db_client, world.customer, job.id, comment=typed[1:])

    assert (refused.status_code, refused.json()) == (422, VALIDATION_ERROR)
    assert (fits.status_code, fits.json()["comment_redacted"]) == (201, True)
    assert [len(r.comment or "") for r in await rows(db_session)] == [1000]


@pytest.mark.parametrize("job_id", ["not-a-uuid", "123"])
async def test_a_bad_job_id_is_422(
    db_client: httpx.AsyncClient, world: JobWorld, job_id: str
) -> None:
    answers = [
        await post(db_client, world.customer, job_id),
        await mine(db_client, world.customer, job_id),
    ]

    assert [(r.status_code, r.json()) for r in answers] == [(422, VALIDATION_ERROR)] * 2


# --- Reading my own review -------------------------------------------------------------------


async def test_mine_returns_the_callers_review_and_never_the_other_sides(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await confirmed_job(db_session, world)
    pros_note = "zqxj-pro-side-note"
    customers_note = "zqxj-customer-side-note"
    by_pro = await post(db_client, world.pro, job.id, overall=2, punctuality=1, comment=pros_note)

    # The pro reviewed; the customer did not yet.
    before = await mine(db_client, world.customer, job.id)
    by_customer = await post(
        db_client, world.customer, job.id, overall=5, quality=4, comment=customers_note
    )
    customers = await mine(db_client, world.customer, job.id)
    pros = await mine(db_client, world.pro, job.id)

    assert (before.status_code, before.json()) == (200, {"review": None, "can_review": True})
    assert (by_pro.status_code, by_customer.status_code) == (201, 201)
    assert set(by_customer.json()) == CREATED_KEYS
    for response in (before, by_customer, customers):
        assert pros_note not in response.text
    assert customers_note not in pros.text
    assert set(customers.json()) == {"review", "can_review"}
    assert set(customers.json()["review"]) == REVIEW_KEYS
    assert customers.json() == {
        "review": {
            "id": by_customer.json()["id"],
            "overall": 5,
            "communication": None,
            "quality": 4,
            "punctuality": None,
            "value": None,
            "comment": customers_note,
            "created_at": by_customer.json()["created_at"],
        },
        "can_review": False,
    }
    assert pros.json() == {
        "review": {
            "id": by_pro.json()["id"],
            "overall": 2,
            "communication": None,
            "quality": None,
            "punctuality": 1,
            "value": None,
            "comment": pros_note,
            "created_at": by_pro.json()["created_at"],
        },
        "can_review": False,
    }


async def test_mine_is_about_one_job_only(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    reviewed, pending = [await confirmed_job(db_session, world) for _ in range(2)]
    created = await post(db_client, world.customer, reviewed.id, overall=3)

    answers = [await mine(db_client, world.customer, job.id) for job in (reviewed, pending)]

    assert answers[0].json()["review"]["id"] == created.json()["id"]
    assert answers[0].json()["can_review"] is False
    assert answers[1].json() == {"review": None, "can_review": True}


# --- My rating --------------------------------------------------------------------------------

# The publication window (the settings' default) and an age safely past it.
WINDOW: Final = timedelta(days=14)
LONG_AGO: Final = timedelta(days=15)
NO_RATING: Final = {"average": None, "count": 0}


async def published_job(session: AsyncSession, world: JobWorld, *, pro: Pro | None = None) -> Job:
    """A job confirmed longer ago than the publication window: a review of it counts for its
    target whether or not the target reviewed it too."""
    confirmed_at = datetime.now(UTC) - LONG_AGO
    return await confirmed_job(
        session,
        world,
        pro=pro,
        completed_at=confirmed_at - timedelta(hours=4),
        confirmed_at=confirmed_at,
    )


@pytest.mark.parametrize("side", ["customer", "pro", "pro_without_profile"])
async def test_no_reviews_is_no_rating_yet(
    db_client: httpx.AsyncClient, world: JobWorld, side: str
) -> None:
    assert await rating(db_client, getattr(world, side)) == NO_RATING


@pytest.mark.parametrize(
    ("ratings", "average"),
    [
        ([5], 5.0),
        ([1], 1.0),
        ([4, 5], 4.5),
        ([4, 4, 4, 5], 4.3),  # 4.25: a tie rounds up, not to the even digit
        ([3, 4, 4, 4], 3.8),  # 3.75
        ([5, 5, 4], 4.7),  # 4.666...
        ([5, 4, 4], 4.3),  # 4.333...
        ([1, 2, 2], 1.7),  # 1.666...
        ([1, 1, 1, 1, 1, 2], 1.2),  # 1.1666...
    ],
)
async def test_the_rating_is_the_average_to_one_decimal_and_the_count(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    ratings: list[int],
    average: float,
) -> None:
    for overall in ratings:
        job = await published_job(db_session, world)
        # The other dimensions never count.
        await seed(db_session, job, world.customer, world.pro, overall, quality=1, value=5)

    assert await rating(db_client, world.pro) == {"average": average, "count": len(ratings)}


async def test_a_rating_counts_only_the_reviews_of_the_caller(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    jobs = [await published_job(db_session, world) for _ in range(3)]
    elsewhere = await published_job(db_session, world, pro=world.other_pro)
    for job, overall in zip(jobs, (5, 4, 4), strict=True):
        await seed(db_session, job, world.customer, world.pro, overall)
    # What the pro wrote about the customer, and what another pro got and wrote.
    for job, overall in zip(jobs[:2], (2, 1), strict=True):
        await seed(db_session, job, world.pro, world.customer, overall)
    await seed(db_session, elsewhere, world.customer, world.other_pro, 1)
    await seed(db_session, elsewhere, world.other_pro, world.customer, 3)

    assert await rating(db_client, world.pro) == {"average": 4.3, "count": 3}
    assert await rating(db_client, world.customer) == {"average": 2.0, "count": 3}
    assert await rating(db_client, world.other_pro) == {"average": 1.0, "count": 1}
    assert await rating(db_client, world.other_customer) == NO_RATING


async def test_a_review_i_wrote_never_counts_in_my_own_rating(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await published_job(db_session, world)

    created = await post(db_client, world.customer, job.id, overall=5)

    assert created.status_code == 201, created.text
    assert await rating(db_client, world.pro) == {"average": 5.0, "count": 1}
    assert await rating(db_client, world.customer) == NO_RATING


# --- A review counts once it is published ----------------------------------------------------


@pytest.mark.parametrize("author", ["customer", "pro"])
async def test_a_review_its_target_has_not_answered_is_not_counted_for_them(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, author: str
) -> None:
    job = await confirmed_job(db_session, world)  # confirmed an hour ago
    writer: Party = getattr(world, author)
    target: Party = world.pro if author == "customer" else world.customer

    created = await post(db_client, writer, job.id, overall=1)

    assert created.status_code == 201, created.text
    # The target wrote no review of this job yet: the score is not theirs to see.
    assert await rating(db_client, target) == NO_RATING
    assert (await mine(db_client, target, job.id)).json() == {"review": None, "can_review": True}
    # The review exists all the same: its author reads it back and cannot write another.
    own = await mine(db_client, writer, job.id)
    again = await post(db_client, writer, job.id, overall=5)
    assert (own.json()["review"]["overall"], own.json()["can_review"]) == (1, False)
    assert (again.status_code, again.json()) == (409, ALREADY_REVIEWED)


async def test_both_reviews_count_once_both_sides_reviewed_the_job(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await confirmed_job(db_session, world)

    await post(db_client, world.customer, job.id, overall=4)
    before = [await rating(db_client, party) for party in (world.pro, world.customer)]
    await post(db_client, world.pro, job.id, overall=2)

    assert before == [NO_RATING, NO_RATING]
    assert await rating(db_client, world.pro) == {"average": 4.0, "count": 1}
    assert await rating(db_client, world.customer) == {"average": 2.0, "count": 1}


async def test_a_review_of_another_job_publishes_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    first, second = [await confirmed_job(db_session, world) for _ in range(2)]

    # Each side wrote one review, of different jobs: neither answered the other's.
    await post(db_client, world.customer, first.id, overall=1)
    await post(db_client, world.pro, second.id, overall=2)

    assert await rating(db_client, world.pro) == NO_RATING
    assert await rating(db_client, world.customer) == NO_RATING


async def test_a_lone_review_counts_once_the_window_since_the_confirmation_has_passed(
    app: FastAPI, db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    confirmed_at = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)
    clock = [confirmed_at]
    app.dependency_overrides[get_review_clock] = lambda: lambda: clock[0]
    job = await make_job(
        db_session,
        world,
        JobStatus.CONFIRMED,
        completed_at=confirmed_at - timedelta(hours=4),
        confirmed_at=confirmed_at,
    )
    await seed(db_session, job, world.customer, world.pro, 3)
    counted = {"average": 3.0, "count": 1}
    ages = {
        "an hour": timedelta(hours=1),
        "13 days 23 hours": timedelta(days=13, hours=23),
        "a microsecond short": WINDOW - timedelta(microseconds=1),
        "14 days": WINDOW,
        "15 days": timedelta(days=15),
    }

    seen = {}
    for label, age in ages.items():
        clock[0] = confirmed_at + age
        seen[label] = await rating(db_client, world.pro)

    # The window is due at its very end; the pro never reviewed this job.
    assert seen == {
        "an hour": NO_RATING,
        "13 days 23 hours": NO_RATING,
        "a microsecond short": NO_RATING,
        "14 days": counted,
        "15 days": counted,
    }
    assert (await mine(db_client, world.pro, job.id)).json() == {
        "review": None,
        "can_review": True,
    }


async def test_only_the_published_reviews_are_averaged(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    answered = await confirmed_job(db_session, world)
    old = await published_job(db_session, world)
    fresh = await confirmed_job(db_session, world)
    await seed(db_session, answered, world.customer, world.pro, 5)
    await seed(db_session, answered, world.pro, world.customer, 2)
    await seed(db_session, old, world.customer, world.pro, 3)
    await seed(db_session, fresh, world.customer, world.pro, 1)

    # Answered and past the window count; the fresh, unanswered one does not.
    assert await rating(db_client, world.pro) == {"average": 4.0, "count": 2}
    assert await rating(db_client, world.customer) == {"average": 2.0, "count": 1}


async def test_the_window_comes_from_settings(db_session: AsyncSession, world: JobWorld) -> None:
    confirmed_at = datetime.now(UTC) - timedelta(days=3, minutes=1)
    job = await confirmed_job(
        db_session,
        world,
        completed_at=confirmed_at - timedelta(hours=4),
        confirmed_at=confirmed_at,
    )
    await seed(db_session, job, world.customer, world.pro, 5)
    seen = {}

    for days in (14, 3):
        app = _app(make_settings(review_publish_after_days=days), db_session)
        async with _client(app) as client:
            seen[days] = await rating(client, world.pro)

    assert make_settings().review_publish_after_days == 14
    assert seen == {14: NO_RATING, 3: {"average": 5.0, "count": 1}}


async def test_a_job_with_no_confirmation_time_never_passes_the_window(
    app: FastAPI, db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    app.dependency_overrides[get_review_clock] = lambda: lambda: datetime(2099, 1, 1, tzinfo=UTC)
    # Fixtures only: the state machine sets confirmed_at on every job it confirms.
    job = await make_job(db_session, world, JobStatus.CONFIRMED)
    await seed(db_session, job, world.customer, world.pro, 5)

    unanswered = await rating(db_client, world.pro)
    await seed(db_session, job, world.pro, world.customer, 4)

    assert unanswered == NO_RATING
    assert await rating(db_client, world.pro) == {"average": 5.0, "count": 1}


# --- The comment is redacted ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("typed", "hidden"),
    [
        (COMMENT, (PHONE, EMAIL)),
        (f"Text me {SENTINEL}: {PHONE}", (PHONE,)),
        (f"{SENTINEL} mail {EMAIL} please", (EMAIL,)),
        (f"{SENTINEL} I am at reach dot me dot zq77 at gmail dot com", ("gmail", "zq77")),
        (f"{SENTINEL} come by {LINE1} next time", (LINE1,)),
    ],
    ids=["phone+email", "phone", "email", "spelled-email", "address"],
)
@pytest.mark.parametrize("side", ["customer", "pro"])
async def test_contact_details_in_the_comment_are_masked_and_only_the_masked_text_is_kept(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    side: str,
    typed: str,
    hidden: tuple[str, ...],
) -> None:
    job = await confirmed_job(db_session, world)
    party: Party = getattr(world, side)

    response = await post(db_client, party, job.id, comment=typed)
    read = await mine(db_client, party, job.id)

    assert response.status_code == 201, response.text
    assert response.json()["comment_redacted"] is True
    [review] = await rows(db_session)
    assert review.comment is not None
    assert MASK in review.comment
    # The rest of the text is kept as typed.
    assert SENTINEL in review.comment
    assert read.json()["review"]["comment"] == review.comment
    # No column of the row holds the original, and the answers never echo it.
    stored = await db_session.scalar(text("SELECT row_to_json(r)::text FROM reviews r"))
    assert stored is not None
    for secret in hidden:
        assert secret not in stored
        assert secret not in response.text
        assert secret not in read.text


async def test_a_comment_with_no_contact_details_is_kept_as_typed(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await confirmed_job(db_session, world)
    typed = "Arrived at 9:30, replaced 2 valves for $180. 10/10, would hire again in 2027!"

    response = await post(db_client, world.customer, job.id, comment=typed)

    assert response.status_code == 201, response.text
    assert response.json()["comment_redacted"] is False
    assert [r.comment for r in await rows(db_session)] == [typed]


# --- Logs and Sentry -------------------------------------------------------------------------


async def test_logs_carry_ids_only(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await confirmed_job(db_session, world)
    scheduled = await make_job(db_session, world)

    with caplog.at_level(logging.DEBUG):
        created = await post(db_client, world.customer, job.id, comment=COMMENT)
        again = await post(db_client, world.customer, job.id, comment=COMMENT)
        early = await post(db_client, world.customer, scheduled.id, comment=COMMENT)
        invalid = await post(db_client, world.pro, job.id, quality=5, comment=COMMENT)
        too_long = await post(db_client, world.pro, job.id, comment=COMMENT * 20)
        stranger = await post(db_client, world.other_pro, job.id, comment=COMMENT)
        await mine(db_client, world.customer, job.id)
        await rating(db_client, world.pro)

    assert [r.status_code for r in (created, again, early, invalid, too_long, stranger)] == [
        201,
        409,
        409,
        422,
        422,
        404,
    ]
    [written] = [r for r in caplog.records if r.getMessage() == "review_created"]
    assert written.levelno == logging.INFO
    fields = (
        "review_id",
        "job_id",
        "author_id",
        "target_id",
        "author_role",
        "has_comment",
        "comment_redacted",
    )
    assert {key: written.__dict__[key] for key in fields} == {
        "review_id": created.json()["id"],
        "job_id": str(job.id),
        "author_id": str(world.customer.id),
        "target_id": str(world.pro.id),
        "author_role": "customer",
        "has_comment": True,
        "comment_redacted": True,
    }
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]
    logs = "\n".join(JsonFormatter().format(r) + r.getMessage() for r in caplog.records)
    assert created.json()["id"] in logs
    for leak in (*TEXT_LEAKS, MASK):
        assert leak not in logs


@pytest.mark.parametrize("failure", ["runtime_error", "check_violation"])
async def test_a_failed_write_is_a_500_that_sends_no_text_to_sentry_or_the_logs(
    db_session: AsyncSession,
    world: JobWorld,
    sentry_transport: MemoryTransport,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    failure: str,
) -> None:
    job = await confirmed_job(db_session, world)
    app = _app(make_settings(sentry_dsn=TEST_DSN), db_session)
    real_add = ReviewRepository.add

    async def fail(self: ReviewRepository, review: Review) -> Review:
        if failure == "runtime_error":
            raise RuntimeError("probe failure")
        # A constraint other than the one-per-side one: a bug, never "already reviewed".
        review.overall = 9
        return await real_add(self, review)

    monkeypatch.setattr(ReviewRepository, "add", fail)
    with caplog.at_level(logging.DEBUG):
        async with _client(app) as client:
            response = await post(client, world.customer, job.id, comment=COMMENT)
    sentry_sdk.flush()

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"
    assert await rows(db_session) == []
    payloads = _payloads(sentry_transport)
    assert any('"exception"' in p for p in payloads), "no event was captured"
    wire = "\n".join(payloads)
    logs = "\n".join(JsonFormatter().format(r) + r.getMessage() for r in caplog.records)
    for leak in TEXT_LEAKS:
        assert leak not in response.text
        assert leak not in wire
        assert leak not in logs


# --- Rate limit -------------------------------------------------------------------------------


async def test_writes_are_rate_limited_per_user(db_session: AsyncSession, world: JobWorld) -> None:
    jobs = [await confirmed_job(db_session, world) for _ in range(3)]
    app = _app(make_settings(review_create_limit=2, review_create_window_seconds=3_600), db_session)
    limiter = InMemoryRateLimiter(lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    async with _client(app) as client:
        # A refused attempt counts: the limit bounds the attempts, not the rows.
        statuses = [
            (await post(client, world.customer, jobs[0].id, overall=9)).status_code,
            (await post(client, world.customer, jobs[1].id)).status_code,
        ]
        limited = await post(client, world.customer, jobs[2].id)
        other = await post(client, world.pro, jobs[2].id)
        reads = [
            await mine(client, world.customer, jobs[2].id),
            await client.get(RATING, headers=world.customer.headers),
        ]

    assert statuses == [422, 201]
    assert (limited.status_code, limited.json()) == (429, RATE_LIMITED)
    assert int(limited.headers["Retry-After"]) > 0
    # Another user has their own count, and reading is not limited.
    assert other.status_code == 201
    assert [r.status_code for r in reads] == [200, 200]
    assert sorted((r.job_id, r.author_id) for r in await rows(db_session)) == sorted(
        [(jobs[1].id, world.customer.id), (jobs[2].id, world.pro.id)]
    )


def test_the_limit_comes_from_settings() -> None:
    settings = make_settings()

    assert (settings.review_create_limit, settings.review_create_window_seconds) == (20, 3_600)


# --- The contract -----------------------------------------------------------------------------


def test_openapi_documents_every_answer(app: FastAPI) -> None:
    paths = app.openapi()["paths"]
    create = paths["/v1/jobs/{job_id}/reviews"]["post"]
    read = paths["/v1/jobs/{job_id}/reviews/mine"]["get"]
    my_rating = paths["/v1/users/me/rating"]["get"]
    error = {"$ref": "#/components/schemas/ErrorResponse"}

    assert set(create["responses"]) == {"201", "401", "403", "404", "409", "422", "429"}
    assert set(read["responses"]) == {"200", "401", "403", "404", "422"}
    assert {"200", "401", "403"} <= set(my_rating["responses"])
    assert "counts published reviews" in my_rating["description"]
    rating_fields = app.openapi()["components"]["schemas"]["RatingOut"]["properties"]
    assert "published reviews" in rating_fields["average"]["description"]
    assert "published reviews" in rating_fields["count"]["description"]
    for operation in (create, read, my_rating):
        for code, answer in operation["responses"].items():
            if code not in ("200", "201"):
                assert answer["content"]["application/json"]["schema"] == error, code
    conflict = create["responses"]["409"]["description"]
    assert "job_not_reviewable" in conflict
    assert "already_reviewed" in conflict
    # The pro's two refused dimensions are said where the app's developer reads them.
    invalid = create["responses"]["422"]["description"]
    assert "quality or value sent by the job's pro" in invalid
    fields = app.openapi()["components"]["schemas"]["ReviewIn"]["properties"]
    for dimension in ("quality", "value"):
        assert "refused (422) from the pro" in fields[dimension]["description"]
    assert "Retry-After" in create["responses"]["429"]["headers"]
