"""A pro's public profile and published reviews (#78): who is shown, what, the rating computed by
query from the published reviews, the pages, the privacy of everyone involved. On the
rolled-back test session; nothing is stored, so no write races the rating (see
reviews/ratings.py)."""

import base64
import json
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Final

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import event, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.storage import get_storage
from app.modules.jobs.models import Job, JobStatus
from app.modules.pros.models import (
    ProCategory,
    ProDocument,
    ProDocumentType,
    ProProfile,
    ProVerificationStatus,
)
from app.modules.reviews.models import Review
from app.modules.reviews.ratings import rating_text, rounded_average
from app.modules.users.models import User
from app.modules.users.types import UserRole, UserStatus
from app.rate_limit import get_rate_limiter
from tests.conftest import InMemoryRateLimiter, make_settings
from tests.job_world import (
    PRO_EMAIL,
    PRO_PHONE,
    JobWorld,
    build_world,
    make_job,
    record_pushes,
)
from tests.ratings_seed import confirmed_job, rate
from tests.test_pros_profile_api import FakeStorage

NOW: Final = datetime(2030, 2, 1, 12, 0, tzinfo=UTC)
LICENSE: Final = "probe-license-78"
STRIPE: Final = "acct_probe78"
PHOTO: Final = "u/probe-photo-78.jpg"


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    world = await build_world(db_session)
    profile = await db_session.get(ProProfile, world.pro.profile_id)
    assert profile is not None
    # Every private field filled, so a leak would show.
    profile.bio = f"Water heaters. Write to {PRO_EMAIL} or call 305 555 0164."
    profile.stripe_account_id = STRIPE
    profile.photo_key = PHOTO
    profile.created_at = datetime(2025, 3, 17, 9, 0, tzinfo=UTC)
    # Never read: the rating is computed (#78).
    profile.rating_avg = Decimal("1.00")
    profile.jobs_count = 99
    db_session.add_all(
        [
            ProCategory(pro_id=world.pro.profile_id, category_id=world.category_id),
            ProDocument(
                pro_id=world.pro.profile_id,
                doc_type=ProDocumentType.LICENSE,
                file_key=f"u/{LICENSE}.pdf",
            ),
        ]
    )
    await db_session.flush()
    return world


def profile_path(pro_id: uuid.UUID) -> str:
    return f"/v1/pros/{pro_id}"


def reviews_path(pro_id: uuid.UUID) -> str:
    return f"/v1/pros/{pro_id}/reviews"


async def name_reviewer(session: AsyncSession, job_id: uuid.UUID, first: str, last: str) -> None:
    job = await session.get(Job, job_id)
    assert job is not None
    await session.execute(
        update(User).where(User.id == job.customer_id).values(first_name=first, last_name=last)
    )


@contextmanager
def counted_statements(session: AsyncSession) -> Iterator[list[str]]:
    statements: list[str] = []
    engine = session.get_bind().engine

    def record(*args: Any) -> None:
        statements.append(args[2])

    event.listen(engine, "before_cursor_execute", record)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", record)


# --- The rating: one rule, half up, null with none --------------------------------------------


@pytest.mark.parametrize(
    ("total", "count", "shown"),
    [
        (0, 0, None),  # no rating: never 0.0
        (5, 1, "5.0"),
        (1, 1, "1.0"),
        (9, 2, "4.5"),
        (17, 4, "4.3"),  # 4.25: half up
        (14, 3, "4.7"),  # 4.666...
        (13, 3, "4.3"),  # 4.333...
        (247, 50, "4.9"),  # 4.94
        (149, 30, "5.0"),  # 4.9666...
        (4_999, 1_000, "5.0"),  # 4.999
        (4_949, 1_000, "4.9"),  # 4.949
        (4_950, 1_000, "5.0"),  # 4.95: half up
    ],
)
def test_the_average_is_rounded_half_up_to_one_decimal(
    total: int, count: int, shown: str | None
) -> None:
    assert rating_text(rounded_average(total, count)) == shown


# --- The profile ------------------------------------------------------------------------------


async def test_a_pro_s_profile_counts_published_reviews_and_confirmed_jobs_only(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    """Published: past the window (5 and 4) or answered by the pro (3). Not yet: confirmed now
    and unanswered (1). Jobs completed: the four confirmed ones and one paid out after its
    confirmation; not a completed one awaiting confirmation, nor one paid out without one."""
    pro = world.pro.profile_id
    await rate(db_session, pro, 5, 4)
    await rate(db_session, pro, 3, published=False, answered=True)
    await rate(db_session, pro, 1, published=False)
    await confirmed_job(db_session, pro, status=JobStatus.PAID_OUT)
    await make_job(db_session, world, JobStatus.COMPLETED)
    await make_job(db_session, world, JobStatus.PAID_OUT)  # a dispute's release: no confirmation

    response = await db_client.get(profile_path(pro), headers=world.customer.headers)

    assert response.status_code == 200, response.text
    body = response.json()
    [category] = body.pop("categories")
    assert category["id"] == str(world.category_id)
    assert body == {
        "id": str(pro),
        "name": "María P.",
        "rating_avg": "4.0",  # (5 + 4 + 3) / 3
        "rating_count": 3,
        "jobs_count": 5,
        "years_of_experience": 7,
        "verified": True,
        "pro_deleted": False,
        "bio": body["bio"],
        "member_since": "2025-03-01",
    }
    assert PRO_EMAIL not in body["bio"]
    assert "0164" not in body["bio"]
    assert response.headers["cache-control"] == "no-store"


async def test_a_pro_with_no_published_review_has_no_rating_not_zero(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    await rate(db_session, world.pro.profile_id, 2, published=False)

    body = (
        await db_client.get(profile_path(world.pro.profile_id), headers=world.pro.headers)
    ).json()

    assert (body["rating_avg"], body["rating_count"], body["jobs_count"]) == (None, 0, 1)


@pytest.mark.parametrize(
    "who", ["customer", "other_customer", "pro", "other_pro", "agent", "admin"]
)
async def test_any_signed_in_user_reads_it_and_nobody_else(
    db_client: httpx.AsyncClient, world: JobWorld, who: str
) -> None:
    headers = getattr(world, who).headers
    pro = world.pro.profile_id

    assert (await db_client.get(profile_path(pro), headers=headers)).status_code == 200
    assert (await db_client.get(reviews_path(pro), headers=headers)).status_code == 200
    for anonymous in (
        await db_client.get(profile_path(pro)),
        await db_client.get(reviews_path(pro)),
    ):
        assert anonymous.status_code == 401


HIDDEN: Final = ("missing", "pending", "rejected", "suspended", "demoted", "no_profile")


async def hide(session: AsyncSession, world: JobWorld, case: str) -> uuid.UUID:
    """The id a reader asks for, in each case nobody may see a profile."""
    other = world.other_pro
    if case == "missing":
        return uuid.uuid4()
    if case in ("pending", "rejected"):
        status = ProVerificationStatus(case)
        await session.execute(
            update(ProProfile)
            .where(ProProfile.id == other.profile_id)
            .values(verification_status=status)
        )
    elif case == "suspended":
        await session.execute(
            update(User).where(User.id == other.id).values(status=UserStatus.SUSPENDED)
        )
    elif case == "demoted":
        await session.execute(
            update(User).where(User.id == other.id).values(role=UserRole.CUSTOMER)
        )
    elif case == "no_profile":
        # A pro account whose id is not a profile's: the account's own id.
        return world.pro_without_profile.id
    return other.profile_id


async def test_every_hidden_profile_is_the_same_404(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    """Pending, rejected, suspended, no longer a pro, no profile, no such id: the same status,
    body and headers, from the same statements, on both routes, so nobody can probe who
    applied."""
    seen: dict[str, list[tuple[int, Any, str, str, int]]] = {}
    for case in HIDDEN:
        savepoint = await db_session.begin_nested()
        await db_session.execute(select(1))  # the savepoint is opened before the count
        target = await hide(db_session, world, case)
        db_session.expunge_all()
        answers = []
        for route in (profile_path(target), reviews_path(target)):
            with counted_statements(db_session) as statements:
                response = await db_client.get(route, headers=world.customer.headers)
            answers.append(
                (
                    response.status_code,
                    response.json(),
                    response.headers["cache-control"],
                    response.headers["content-type"],
                    len(statements),
                )
            )
        seen[case] = answers
        await savepoint.rollback()

    first = seen["missing"]
    assert first[0][:2] == (
        404,
        {"error": {"code": "not_found", "message": "Resource not found."}},
    ), first
    for case, answers in seen.items():
        assert answers == first, case


# --- The reviews ------------------------------------------------------------------------------


async def test_the_reviews_are_the_published_ones_newest_first_paged(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    pro = world.pro.profile_id
    jobs = await rate(db_session, pro, 5, 4, 3, comment="Fixed it fast.")
    await rate(db_session, pro, 1, published=False, comment="not yet published")
    await name_reviewer(db_session, jobs[0], "Ana", "Silva")
    await name_reviewer(db_session, jobs[1], "repair.example.com", "Smith")
    stamps = [datetime(2030, 1, day, tzinfo=UTC) for day in (3, 2, 1)]  # the 5 is newest
    for job_id, stamp in zip(jobs, stamps, strict=True):
        await db_session.execute(
            update(Review).where(Review.job_id == job_id).values(created_at=stamp)
        )

    first = await db_client.get(
        reviews_path(pro), params={"limit": 2}, headers=world.customer.headers
    )
    assert first.status_code == 200, first.text
    page = first.json()
    second = await db_client.get(
        reviews_path(pro),
        params={"limit": 2, "cursor": page["next_cursor"]},
        headers=world.customer.headers,
    )

    assert page["items"] == [
        {
            "rating": 5,
            "comment": "Fixed it fast.",
            "reviewer": "Ana S.",
            "reviewer_deleted": False,
            "created_on": "2030-01-03",
        },
        # A name that shows a contact is withheld, never partly masked.
        {
            "rating": 4,
            "comment": "Fixed it fast.",
            "reviewer": None,
            "reviewer_deleted": False,
            "created_on": "2030-01-02",
        },
    ]
    assert second.json() == {
        "items": [
            {
                "rating": 3,
                "comment": "Fixed it fast.",
                "reviewer": None,
                "reviewer_deleted": False,
                "created_on": "2030-01-01",
            }
        ],
        "next_cursor": None,
    }
    assert "not yet published" not in first.text + second.text


async def test_an_empty_page_and_a_page_of_exactly_the_limit_have_no_next(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    pro = world.pro.profile_id
    empty = await db_client.get(reviews_path(pro), headers=world.customer.headers)
    assert empty.json() == {"items": [], "next_cursor": None}

    await rate(db_session, pro, 5, 4)
    exact = await db_client.get(
        reviews_path(pro), params={"limit": 2}, headers=world.customer.headers
    )

    assert len(exact.json()["items"]) == 2
    assert exact.json()["next_cursor"] is None


def _cursor(raw: str) -> str:
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


@pytest.mark.parametrize(
    "params",
    [
        {"cursor": "not-a-cursor!"},
        {"cursor": _cursor("2030-01-01T00:00:00|not-a-uuid")},
        {"cursor": _cursor(f"2030-01-01T00:00:00|{uuid.uuid4()}")},  # naive: not ours
        {"cursor": _cursor("yesterday")},
        {"cursor": "x" * 201},
        {"limit": 0},
        {"limit": 101},
    ],
)
async def test_a_page_this_api_did_not_offer_is_refused(
    db_client: httpx.AsyncClient, world: JobWorld, params: dict[str, str | int]
) -> None:
    response = await db_client.get(
        reviews_path(world.pro.profile_id), params=params, headers=world.customer.headers
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


# --- Privacy ----------------------------------------------------------------------------------


async def test_nothing_private_about_anyone_is_in_either_answer(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    """No contact, address, document, license, Stripe account, photo, last name, or id of any
    user (the pro's account, the reviewers), whatever the page."""
    pro = world.pro.profile_id
    jobs = await rate(db_session, pro, 5, 4)
    await name_reviewer(db_session, jobs[0], "Ana", "Probesurname")
    reviewers = list(
        (await db_session.scalars(select(Job.customer_id).where(Job.id.in_(jobs)))).all()
    )
    reviewer_emails = list(
        (await db_session.scalars(select(User.email).where(User.id.in_(reviewers)))).all()
    )

    answers = [
        await db_client.get(profile_path(pro), headers=world.customer.headers),
        await db_client.get(reviews_path(pro), headers=world.customer.headers),
    ]

    text = "".join(json.dumps(answer.json()) for answer in answers)
    sentinels = [
        PRO_EMAIL,
        PRO_PHONE,
        "305 555 0164",
        "Pérez",
        "Probesurname",
        LICENSE,
        STRIPE,
        PHOTO,
        str(world.pro.id),
        *map(str, reviewers),
        *reviewer_emails,
        *(str(job_id) for job_id in jobs),
    ]
    for sentinel in sentinels:
        assert sentinel not in text, sentinel


# --- The same rating everywhere ---------------------------------------------------------------


async def test_the_job_s_pro_card_carries_the_computed_rating(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world, JobStatus.SCHEDULED)
    await rate(db_session, world.pro.profile_id, 5, 4)

    response = await db_client.get(
        f"/v1/requests/{job.request_id}/job", headers=world.customer.headers
    )

    assert response.status_code == 200, response.text
    card = response.json()["pro"]
    assert (card["rating_avg"], card["rating_count"], card["jobs_count"]) == ("4.5", 2, 2)


# --- Rate limit -------------------------------------------------------------------------------

LIMITED: Final = make_settings(pro_public_read_limit=2)
RATE_LIMITED: Final = {
    "error": {"code": "rate_limited", "message": "Too many requests. Try again later."}
}


@pytest.mark.parametrize("settings", [LIMITED])
async def test_reads_are_limited_per_user_across_both_routes(
    app: FastAPI, db_client: httpx.AsyncClient, world: JobWorld
) -> None:
    limiter = InMemoryRateLimiter(clock=lambda: NOW.timestamp())
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    pro = world.pro.profile_id

    answers = [
        await db_client.get(profile_path(pro), headers=world.customer.headers),
        await db_client.get(reviews_path(pro), headers=world.customer.headers),
        await db_client.get(profile_path(pro), headers=world.customer.headers),
    ]
    other = await db_client.get(profile_path(pro), headers=world.other_customer.headers)

    assert [answer.status_code for answer in answers] == [200, 200, 429]
    assert answers[2].json() == RATE_LIMITED
    assert int(answers[2].headers["retry-after"]) > 0
    assert other.status_code == 200


async def test_a_pro_s_own_profile_stays_at_me(
    app: FastAPI, db_client: httpx.AsyncClient, world: JobWorld
) -> None:
    """/v1/pros/me is matched before /v1/pros/{pro_id}: still the pro's own profile."""
    app.dependency_overrides[get_storage] = FakeStorage
    record_pushes(app)  # the route takes the job queue
    response = await db_client.get("/v1/pros/me", headers=world.other_pro.headers)

    assert response.status_code == 200, response.text
    # The pro's own view (their payouts and verification), not the public profile.
    assert {"payouts_enabled", "verification_status", "service_areas"} <= set(response.json())
