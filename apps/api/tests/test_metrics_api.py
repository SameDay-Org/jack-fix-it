"""The staff metrics (#84): hand-computed figures over a seeded range, the range's edges at
business-time-zone midnight across a daylight-saving change, who may read them, and what the
answer never holds.

The seeded range is 9 and 10 March 2031 in America/New_York: clocks go forward at 02:00 on
the 9th, so the range spans 2031-03-09T05:00Z (00:00 EST) to 2031-03-11T04:00Z (00:00 EDT
on the 11th), 47 hours. Nothing else in the test database is dated 2031.
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any, Final

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import event, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.disputes.models import Dispute, DisputeReason
from app.modules.jobs.models import Job, JobStatus
from app.modules.metrics.router import get_metrics_clock
from app.modules.metrics.service import MetricsConfig, MetricsService
from app.modules.requests.models import ServiceRequest
from app.modules.reviews.models import Review, ReviewAuthorRole
from tests.conftest import make_settings
from tests.job_world import (
    CUSTOMER_EMAIL,
    CUSTOMER_FIRST,
    CUSTOMER_LAST,
    CUSTOMER_PHONE,
    FEE,
    PRICE,
    TAX,
    JobWorld,
    build_world,
    make_accepted_request,
    make_job,
)

PATH: Final = "/v1/admin/metrics"
ZONE: Final = "America/New_York"
RANGE: Final = {"from": "2031-03-09", "to": "2031-03-10", "tz": ZONE}
# Today, for the default range: 2031-04-20 08:00 in New York.
NOW: Final = datetime(2031, 4, 20, 12, 0, tzinfo=UTC)
NO_STORE: Final = "no-store"


def at(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=UTC)


class Clock:
    def __init__(self) -> None:
        self.now = NOW

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture
def settings() -> Settings:
    return make_settings(business_time_zone=ZONE, metrics_read_limit=1_000)


@pytest.fixture
def clock(app: FastAPI) -> Clock:
    fixed = Clock()
    app.dependency_overrides[get_metrics_clock] = lambda: fixed
    return fixed


@pytest.fixture
async def world(db_session: AsyncSession, clock: Clock) -> JobWorld:
    # Committed: the metrics end their transaction with a rollback.
    built = await build_world(db_session)
    await db_session.commit()
    return built


async def request_at(
    session: AsyncSession, world: JobWorld, created: str, contact_after: int | None = None
) -> uuid.UUID:
    """A request created at `created` (UTC), first contacted `contact_after` minutes later."""
    request, _ = await make_accepted_request(session, world, world.pro)
    created_at = at(created)
    await session.execute(
        update(ServiceRequest)
        .where(ServiceRequest.id == request.id)
        .values(
            created_at=created_at,
            first_contact_at=(
                None if contact_after is None else created_at + timedelta(minutes=contact_after)
            ),
        )
    )
    return request.id


async def job_at(
    session: AsyncSession,
    world: JobWorld,
    status: JobStatus,
    created: str,
    *,
    completed: str | None = None,
    confirmed: str | None = None,
    customer_id: uuid.UUID | None = None,
    price: tuple[int, int, int] | None = None,
) -> Job:
    """A job with these times (UTC); its customer and its amounts (price, tax, fee) changed
    after the fact when given."""
    job = await make_job(
        session,
        world,
        status,
        created_at=at(created),
        completed_at=None if completed is None else at(completed),
        confirmed_at=None if confirmed is None else at(confirmed),
    )
    values: dict[str, Any] = {}
    if customer_id is not None:
        values["customer_id"] = customer_id
    if price is not None:
        cents, tax, fee = price
        values.update(
            customer_price_cents=cents,
            tax_cents=tax,
            platform_fee_cents=fee,
            pro_payout_cents=cents - fee,
        )
    if values:
        await session.execute(update(Job).where(Job.id == job.id).values(**values))
    return job


def review(job: Job, world: JobWorld, overall: int, created: str, *, about_pro: bool) -> Review:
    author, target = (
        (world.customer.id, world.pro.id) if about_pro else (world.pro.id, world.customer.id)
    )
    return Review(
        job_id=job.id,
        author_id=author,
        target_id=target,
        author_role=ReviewAuthorRole.CUSTOMER if about_pro else ReviewAuthorRole.PRO,
        overall=overall,
        created_at=at(created),
    )


async def seed(session: AsyncSession, world: JobWorld) -> None:
    """The range's data; each line says why it counts or not."""
    # Requests: R1 at the range's first instant (00:00 EST), contacted after 10 min; R2 one
    # second before it (out); R3 contacted after 20 min; R4 the last second of the 10th in
    # EDT (in), never contacted; R5 at the range's end (00:00 EDT on the 11th: out).
    await request_at(session, world, "2031-03-09T05:00:00", contact_after=10)
    await request_at(session, world, "2031-03-09T04:59:59", contact_after=5)
    await request_at(session, world, "2031-03-10T12:00:00", contact_after=20)
    await request_at(session, world, "2031-03-11T03:59:59")
    await request_at(session, world, "2031-03-11T04:00:00", contact_after=1)
    # J1: created and completed in the range, confirmed on the 10th; its request R6 was created
    # in the range and contacted after 60 min (the only request with a job).
    j1 = await job_at(
        session,
        world,
        JobStatus.CONFIRMED,
        "2031-03-09T10:00:00",
        completed="2031-03-10T14:00:00",
        confirmed="2031-03-10T20:00:00",
    )
    created = at("2031-03-10T15:00:00")
    await session.execute(
        update(ServiceRequest)
        .where(ServiceRequest.id == j1.request_id)
        .values(created_at=created, first_contact_at=created + timedelta(minutes=60))
    )
    # J2: created in the range, cancelled before it started: in the completion denominator.
    await job_at(session, world, JobStatus.CANCELLED, "2031-03-09T11:00:00")
    # J3: created before the range, completed in it (08:00 EDT on the 9th): a completion of the
    # range, not a job of its cohort; disputed in the range.
    j3 = await job_at(
        session,
        world,
        JobStatus.DISPUTED,
        "2031-03-08T10:00:00",
        completed="2031-03-09T12:00:00",
    )
    # J4: created in the range, completed after it: in the cohort's completions, not the range's.
    j4 = await job_at(
        session,
        world,
        JobStatus.COMPLETED,
        "2031-03-10T09:00:00",
        completed="2031-03-11T05:00:00",
    )
    # J5: the customer's earlier confirmed job (before the range): makes them a repeat customer.
    await job_at(
        session,
        world,
        JobStatus.CONFIRMED,
        "2031-01-10T10:00:00",
        completed="2031-01-31T10:00:00",
        confirmed="2031-02-01T10:00:00",
    )
    # J6: another customer's job confirmed in the range (11:00 EDT on the 9th), cheaper; J7:
    # their second confirmed job, after the range's end: they are not a repeat customer of it.
    other = world.other_customer.id
    await job_at(
        session,
        world,
        JobStatus.CONFIRMED,
        "2031-03-01T10:00:00",
        completed="2031-03-08T10:00:00",
        confirmed="2031-03-09T15:00:00",
        customer_id=other,
        price=(10_000, 0, 1_500),
    )
    await job_at(
        session,
        world,
        JobStatus.CONFIRMED,
        "2031-03-11T10:00:00",
        completed="2031-03-12T10:00:00",
        confirmed="2031-03-12T11:00:00",
        customer_id=other,
    )
    session.add_all(
        [
            # The disputes: one opened in the range, one after it.
            Dispute(
                job_id=j3.id,
                opened_by=world.customer.id,
                reason_code=DisputeReason.POOR_QUALITY,
                description="Leaks",
                created_at=at("2031-03-09T20:00:00"),
            ),
            Dispute(
                job_id=j4.id,
                opened_by=world.customer.id,
                reason_code=DisputeReason.DAMAGE,
                description="Scratched",
                created_at=at("2031-03-11T05:00:00"),
            ),
            # Reviews of the pro in the range (5 and 4), and one after it (1); none of a
            # customer in the range.
            review(j1, world, 5, "2031-03-10T21:00:00", about_pro=True),
            review(j3, world, 4, "2031-03-09T13:00:00", about_pro=True),
            review(j4, world, 1, "2031-03-11T06:00:00", about_pro=True),
            review(j1, world, 2, "2031-03-12T06:00:00", about_pro=False),
        ]
    )
    await session.commit()


def get(client: httpx.AsyncClient, world: JobWorld, **params: str) -> Any:
    return client.get(PATH, params=params, headers=world.agent.headers)


# --- The figures ---


async def test_every_metric_matches_the_hand_computed_figures(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    await seed(db_session, world)

    response = await get(db_client, world, **RANGE)

    assert response.status_code == 200, response.text[:300]
    assert response.headers["cache-control"] == NO_STORE
    body = response.json()
    assert (body["from_date"], body["to_date"], body["time_zone"]) == (
        "2031-03-09",
        "2031-03-10",
        ZONE,
    )
    assert body["refunds_netted"] is False
    m = body["metrics"]
    # R1 10, R3 20, R6 60 minutes: mean 30, median 20.
    assert m["avg_first_response_minutes"] == {
        "formula": "first_response_minutes",
        "value": 30.0,
        "median": 20.0,
        "denominator": 3,
    }
    # Created in the range: R1, R3, R4, R6.
    assert m["contact_rate"] == {
        "formula": "contact_rate",
        "value": 0.75,
        "numerator": 3,
        "denominator": 4,
    }
    assert m["lead_to_job"] == {
        "formula": "lead_to_job",
        "value": 0.25,
        "numerator": 1,
        "denominator": 4,
    }
    # Created in the range: J1, J2 (cancelled), J4; completed at some point: J1, J4.
    assert m["completion_rate"] == {
        "formula": "completion_rate",
        "value": 0.6667,
        "numerator": 2,
        "denominator": 3,
    }
    assert m["pro_rating_avg"] == {"formula": "pro_rating", "value": 4.5, "denominator": 2}
    # No review of a customer in the range: null, never 0 or 5.
    assert m["customer_rating_avg"] == {
        "formula": "customer_rating",
        "value": None,
        "denominator": 0,
    }
    # Opened in the range: one; completed in the range: J1 and J3.
    assert m["dispute_rate"] == {
        "formula": "dispute_rate",
        "value": 0.5,
        "numerator": 1,
        "denominator": 2,
    }
    # Confirmed in the range: the customer (J1; J5 before it) and the other (J6; J7 after it).
    assert m["repeat_rate"] == {
        "formula": "repeat_rate",
        "value": 0.5,
        "numerator": 1,
        "denominator": 2,
    }
    # Confirmed in the range: J1 (price + tax) and J6.
    assert m["gmv_cents"] == {"formula": "gmv", "value": PRICE + TAX + 10_000}
    assert m["revenue_cents"] == {
        "formula": "revenue_gross_of_refunds",
        "value": FEE + 1_500,
    }
    # Per local day: R1 on the 9th (00:00 EST), R3, R4 (23:59:59 EDT) and R6 on the 10th.
    assert body["series"] == [
        {"day": "2031-03-09", "requests_created": 1, "jobs_completed": 1, "gmv_cents": 10_000},
        {
            "day": "2031-03-10",
            "requests_created": 3,
            "jobs_completed": 1,
            "gmv_cents": PRICE + TAX,
        },
    ]


async def test_an_empty_range_is_null_ratios_and_zero_amounts(
    db_client: httpx.AsyncClient, world: JobWorld
) -> None:
    response = await get(db_client, world, **{"from": "2031-06-01", "to": "2031-06-03"})

    assert response.status_code == 200, response.text[:300]
    m = response.json()["metrics"]
    for name in ("contact_rate", "lead_to_job", "completion_rate", "dispute_rate", "repeat_rate"):
        assert (m[name]["value"], m[name]["numerator"], m[name]["denominator"]) == (None, 0, 0)
    assert (
        m["avg_first_response_minutes"]["value"],
        m["avg_first_response_minutes"]["median"],
    ) == (
        None,
        None,
    )
    for name in ("customer_rating_avg", "pro_rating_avg"):
        assert (m[name]["value"], m[name]["denominator"]) == (None, 0)
    assert (m["gmv_cents"]["value"], m["revenue_cents"]["value"]) == (0, 0)
    assert [point["day"] for point in response.json()["series"]] == [
        "2031-06-01",
        "2031-06-02",
        "2031-06-03",
    ]
    assert {point["requests_created"] for point in response.json()["series"]} == {0}


async def test_the_default_range_is_the_last_days_ending_today_in_the_business_zone(
    db_client: httpx.AsyncClient, world: JobWorld, clock: Clock
) -> None:
    # 02:00 UTC on 21 April is still the 20th in New York.
    clock.now = datetime(2031, 4, 21, 2, 0, tzinfo=UTC)

    body = (await get(db_client, world)).json()

    assert (body["from_date"], body["to_date"], body["time_zone"]) == (
        "2031-03-22",
        "2031-04-20",
        ZONE,
    )
    assert len(body["series"]) == 30


async def test_every_figure_comes_from_one_statement(
    db_session: AsyncSession, world: JobWorld, settings: Settings
) -> None:
    """One SELECT reads the tables: one snapshot, so the figures agree with each other. The
    only other statement asks Postgres for today in the zone, from no table."""
    await seed(db_session, world)
    connection = await db_session.connection()
    statements: list[str] = []

    def record(*args: Any) -> None:
        statements.append(args[2])

    event.listen(connection.sync_connection, "before_cursor_execute", record)
    try:
        await MetricsService(db_session, MetricsConfig.from_settings(settings), Clock()).read(
            date(2031, 3, 9), date(2031, 3, 10), None
        )
    finally:
        event.remove(connection.sync_connection, "before_cursor_execute", record)

    selects = [s for s in statements if s.lstrip().upper().startswith("SELECT")]
    assert len(selects) == 2
    assert len([s for s in selects if " FROM " in s.upper()]) == 1


# --- The range ---


@pytest.mark.parametrize(
    ("params", "code"),
    [
        ({"from": "2031-03-11", "to": "2031-03-10"}, "invalid_range"),
        ({"from": "2030-03-09", "to": "2031-03-10"}, "invalid_range"),  # 367 days
        ({"from": "2031-03-10", "to": "2031-03-10", "tz": "Mars/Olympus"}, "invalid_range"),
        ({"tz": "../etc/passwd"}, "validation_error"),
        ({"from": "10/03/2031"}, "validation_error"),
        ({"to": "2031-02-30"}, "validation_error"),
    ],
    ids=["from_after_to", "367_days", "unknown_zone", "zone_pattern", "not_iso", "no_such_day"],
)
async def test_a_range_the_metrics_do_not_read_is_422_and_no_store(
    db_client: httpx.AsyncClient, world: JobWorld, params: dict[str, str], code: str
) -> None:
    response = await get(db_client, world, **params)

    assert response.status_code == 422, response.text[:300]
    assert response.json()["error"]["code"] == code
    assert response.headers["cache-control"] == NO_STORE


async def test_the_longest_range_is_366_days(db_client: httpx.AsyncClient, world: JobWorld) -> None:
    response = await get(db_client, world, **{"from": "2030-03-11", "to": "2031-03-11"})

    assert response.status_code == 200, response.text[:300]
    assert len(response.json()["series"]) == 366


# --- Who ---


async def test_only_agents_and_admins_read_and_every_answer_is_no_store(
    db_client: httpx.AsyncClient, world: JobWorld
) -> None:
    answers = {
        "anonymous": await db_client.get(PATH),
        "customer": await db_client.get(PATH, headers=world.customer.headers),
        "pro": await db_client.get(PATH, headers=world.pro.headers),
        "agent": await db_client.get(PATH, headers=world.agent.headers),
        "admin": await db_client.get(PATH, headers=world.admin.headers),
    }

    assert {who: answer.status_code for who, answer in answers.items()} == {
        "anonymous": 401,
        "customer": 403,
        "pro": 403,
        "agent": 200,
        "admin": 200,
    }
    assert {answer.headers["cache-control"] for answer in answers.values()} == {NO_STORE}


@pytest.mark.parametrize("settings", [make_settings(metrics_read_limit=2)])
async def test_reads_are_limited_per_staff_member(
    db_client: httpx.AsyncClient, world: JobWorld
) -> None:
    answers = [await get(db_client, world) for _ in range(3)]
    other = await db_client.get(PATH, headers=world.admin.headers)

    assert [answer.status_code for answer in answers] == [200, 200, 429]
    assert answers[2].headers["cache-control"] == NO_STORE
    assert other.status_code == 200


async def test_the_answer_never_names_anyone(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    await seed(db_session, world)

    text = (await get(db_client, world, **RANGE)).text

    for leak in (
        CUSTOMER_EMAIL,
        CUSTOMER_PHONE,
        CUSTOMER_FIRST,
        CUSTOMER_LAST,
        str(world.customer.id),
        str(world.pro.id),
    ):
        assert leak not in text
    # Nothing that looks like an id at all.
    assert not any(
        len(part) == 36 and part.count("-") == 4 for part in text.replace('"', " ").split()
    )


def test_the_route_is_in_the_schema_with_its_errors(app: FastAPI) -> None:
    operation = app.openapi()["paths"][PATH]["get"]
    assert set(operation["responses"]) >= {"200", "401", "403", "422", "429"}
    assert {parameter["name"] for parameter in operation["parameters"]} == {"from", "to", "tz"}
