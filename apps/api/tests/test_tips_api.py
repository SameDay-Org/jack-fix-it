"""Tips at confirmation (#273, PR A1): CustomerJob.tip and POST /v1/requests/{id}/job/tip.

On the rolled-back test session, with the payment calls' Stripe fake: no network. The settings
are fixture values, none of them the defaults, so every bound and the window are proven to come
from settings. The job world's price (20,000) and tax (1,400) differ, so a tip taken from the
total with tax shows.
"""

import dataclasses
import io
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.modules.jobs.models import Job, JobStatus
from app.modules.tips.intents import tip_cancel_idempotency_key
from app.modules.tips.models import Tip, TipStatus
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.money import tip_amount
from app.observability import JsonFormatter
from app.rate_limit import RateLimitResult, get_rate_limiter
from scripts import resolve_tip_intent
from tests.audit_helpers import OPERATOR_EMAIL, audit_rows, make_staff
from tests.conftest import InMemoryRateLimiter, make_settings
from tests.job_world import (
    JobWorld,
    build_world,
    make_accepted_request,
    make_job,
    record_pushes,
)
from tests.test_create_staff_user import sessions_of
from tests.test_payments_api import (
    PUBLISHABLE_KEY,
    SPLIT_WORDS,
    FakeStripePayments,
    extra_of,
    field_names,
    stripe_fake,
)

__all__ = ["stripe_fake"]  # a fixture, used by name

# Fixture values, none of them the defaults.
PRESETS = [6, 12, 18]
MIN_CENTS = 150
MAX_PERCENT = 50
CAP_CENTS = 9_000
WINDOW = timedelta(hours=72)
RECONCILE = timedelta(hours=5)
STRIPE_CUSTOMER = "cus_tipfixture273"

NOT_FOUND = {"error": {"code": "not_found", "message": "Resource not found."}}
FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}
NOT_AVAILABLE = "tip_not_available"
ALREADY_PAID = "tip_already_paid"
IN_PROGRESS = "tip_in_progress"
OUT_OF_RANGE = "tip_amount_out_of_range"
NOT_OFFERED = "tip_percent_not_offered"
NEVER_CONFIRMED = [
    JobStatus.SCHEDULED,
    JobStatus.ON_THE_WAY,
    JobStatus.IN_PROGRESS,
    JobStatus.COMPLETED,
    JobStatus.DISPUTED,
    JobStatus.REFUNDED,
    JobStatus.CANCELLED,
    # An admin's release of a dispute: paid out, never confirmed.
    JobStatus.PAID_OUT,
]


@pytest.fixture
def settings() -> Settings:
    # No secret key: without the fake, the real dependency finds no Stripe.
    return make_settings(
        stripe_secret_key=None,
        stripe_publishable_key=PUBLISHABLE_KEY,
        stripe_payment_intent_reconcile_after_seconds=int(RECONCILE.total_seconds()),
        tip_preset_percents=PRESETS,
        tip_min_cents=MIN_CENTS,
        tip_max_percent=MAX_PERCENT,
        tip_max_cents=CAP_CENTS,
        tip_window_hours=int(WINDOW.total_seconds() // 3600),
    )


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    world = await build_world(db_session)
    await db_session.execute(
        update(User).where(User.id == world.customer.id).values(stripe_customer_id=STRIPE_CUSTOMER)
    )
    return world


@dataclass(frozen=True)
class JobRef:
    """A job's ids, copied: a rollback inside a call (a Stripe failure) expires the ORM rows
    the test holds."""

    id: uuid.UUID
    request_id: uuid.UUID
    confirmed_at: datetime | None


async def committed_ref(session: AsyncSession, job: Job) -> JobRef:
    """The job, kept by the test's outer transaction (a commit releases the savepoint, so a
    rollback inside a call does not take the job with it)."""
    ref = JobRef(job.id, job.request_id, job.confirmed_at)
    await session.commit()
    return ref


async def confirmed(
    session: AsyncSession,
    world: JobWorld,
    *,
    ago: timedelta = timedelta(hours=1),
    status: JobStatus = JobStatus.CONFIRMED,
    price: int | None = None,
) -> JobRef:
    """A job the customer confirmed `ago`, in `status` (confirmed, or paid out after it), at
    the world's price or `price`."""
    at = datetime.now(UTC) - ago
    job = await make_job(
        session, world, status, completed_at=at - timedelta(hours=2), confirmed_at=at
    )
    if price is not None:
        job.customer_price_cents = price
        await session.flush()
    return await committed_ref(session, job)


def tip_path(job: JobRef) -> str:
    return f"/v1/requests/{job.request_id}/job/tip"


async def choose(
    client: httpx.AsyncClient,
    world: JobWorld,
    job: JobRef,
    body: object,
    *,
    key: uuid.UUID | None = None,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    sent = {**(headers or world.customer.headers)}
    if key is not None:
        sent["Idempotency-Key"] = str(key)
    return await client.post(tip_path(job), json=body, headers=sent)


async def job_view(client: httpx.AsyncClient, world: JobWorld, job: JobRef) -> dict[str, Any]:
    response = await client.get(
        f"/v1/requests/{job.request_id}/job", headers=world.customer.headers
    )
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def tip_row(session: AsyncSession, job: JobRef) -> Tip | None:
    statement = select(Tip).where(Tip.job_id == job.id).execution_options(populate_existing=True)
    return (await session.scalars(statement)).one_or_none()


async def set_tip(session: AsyncSession, job: JobRef, **values: object) -> None:
    await session.execute(update(Tip).where(Tip.job_id == job.id).values(**values))
    await session.commit()  # kept by the outer transaction, past a rollback inside a call


def code(response: httpx.Response) -> str:
    value: str = response.json()["error"]["code"]
    return value


PERCENT_12 = {"choice": "percent", "percent": 12}
NEEDS_REVIEW = "tip_needs_review"


# The amount and the settings


@pytest.mark.parametrize(
    ("base", "percent", "expected"),
    [(20_000, 12, 2_400), (25, 10, 3), (15, 10, 2), (1, 50, 1), (24, 10, 2), (0, 15, 0)],
)
def test_tip_amount_rounds_half_up_to_the_cent(base: int, percent: int, expected: int) -> None:
    assert tip_amount(base, percent) == expected


@pytest.mark.parametrize(("base", "percent"), [(-1, 10), (100, -1), (True, 10), (100, 1.5)])
def test_tip_amount_refuses_what_is_not_whole_cents_or_percents(base: Any, percent: Any) -> None:
    with pytest.raises(ValueError, match="must be a non-negative integer"):
        tip_amount(base, percent)


def test_tip_presets_are_read_from_a_csv() -> None:
    assert make_settings(tip_preset_percents=" 6, 12,18 ").tip_preset_percents == [6, 12, 18]


@pytest.mark.parametrize(
    "overrides",
    [
        {"tip_preset_percents": "12,6"},
        {"tip_preset_percents": "6,6,12"},
        {"tip_preset_percents": "0,6"},
        {"tip_preset_percents": ""},
        {"tip_preset_percents": "6," + chr(0xFF11) + chr(0xFF12)},  # fullwidth digits
        {"tip_preset_percents": "6,12", "tip_max_percent": 10},
        {"tip_min_cents": 9_001, "tip_max_cents": 9_000},
    ],
)
def test_tip_settings_refuse_bounds_that_cannot_hold(overrides: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        make_settings(**overrides)


# Which jobs take a tip


@pytest.mark.parametrize("status", NEVER_CONFIRMED)
async def test_a_job_never_confirmed_shows_no_tip_and_takes_none(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
    status: JobStatus,
) -> None:
    # Marked done by the pro (completed_at): a tip waits for the confirmation, not for that.
    done = await make_job(db_session, world, status, completed_at=datetime.now(UTC))
    job = await committed_ref(db_session, done)

    assert (await job_view(db_client, world, job))["tip"] is None
    for body in (PERCENT_12, {"choice": "none"}):
        response = await choose(db_client, world, job, body)
        assert response.status_code == 409, response.text
        assert code(response) == NOT_AVAILABLE
    assert await tip_row(db_session, job) is None
    assert stripe_fake.intent_calls == []


@pytest.mark.parametrize("status", [JobStatus.CONFIRMED, JobStatus.PAID_OUT])
async def test_a_confirmed_job_offers_the_servers_amounts(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, status: JobStatus
) -> None:
    job = await confirmed(db_session, world, status=status)
    assert job.confirmed_at is not None

    tip = (await job_view(db_client, world, job))["tip"]

    assert {**tip, "closes_at": None} == {
        "status": None,
        "choice": None,
        "percent": None,
        "amount_cents": 0,
        "currency": "usd",
        "options": {
            # Of the price before tax (20,000), never the total with tax (21,400).
            "presets": [
                {"percent": 6, "amount_cents": 1_200},
                {"percent": 12, "amount_cents": 2_400},
                {"percent": 18, "amount_cents": 3_600},
            ],
            "min_cents": MIN_CENTS,
            # 50% of the price is 10,000: the cap is lower.
            "max_cents": CAP_CENTS,
        },
        "can_tip": True,
        "closes_at": None,
    }
    assert datetime.fromisoformat(tip["closes_at"]) == job.confirmed_at + WINDOW


@pytest.mark.parametrize(
    ("price", "presets", "max_cents"),
    [
        # 6% is 120, under the minimum; the maximum is 50% of the price.
        (2_000, [(12, 240), (18, 360)], 1_000),
        # 12% and 18% are over the cap.
        (100_000, [(6, 6_000)], CAP_CENTS),
    ],
)
async def test_presets_outside_the_jobs_bounds_are_left_out(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    price: int,
    presets: list[tuple[int, int]],
    max_cents: int,
) -> None:
    job = await confirmed(db_session, world, price=price)

    options = (await job_view(db_client, world, job))["tip"]["options"]

    assert options == {
        "presets": [{"percent": p, "amount_cents": a} for p, a in presets],
        "min_cents": MIN_CENTS,
        "max_cents": max_cents,
    }


async def test_the_window_closes_tip_hours_after_the_confirmation(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world, ago=WINDOW + timedelta(minutes=1))

    tip = (await job_view(db_client, world, job))["tip"]
    response = await choose(db_client, world, job, PERCENT_12)

    assert (tip["status"], tip["can_tip"]) == (None, False)
    assert response.status_code == 409
    assert code(response) == NOT_AVAILABLE
    assert stripe_fake.intent_calls == []


# Who may tip


async def test_only_the_jobs_own_customer_may_tip(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    request, _ = await make_accepted_request(db_session, world, world.pro)  # no job yet
    path = tip_path(job)

    other = await db_client.post(path, json=PERCENT_12, headers=world.other_customer.headers)
    pro = await db_client.post(path, json=PERCENT_12, headers=world.pro.headers)
    staff = await db_client.post(path, json=PERCENT_12, headers=world.admin.headers)
    anonymous = await db_client.post(path, json=PERCENT_12)
    no_job = await db_client.post(
        f"/v1/requests/{request.id}/job/tip", json=PERCENT_12, headers=world.customer.headers
    )
    unknown = await db_client.post(
        f"/v1/requests/{uuid.uuid4()}/job/tip", json=PERCENT_12, headers=world.customer.headers
    )

    assert (other.status_code, other.json()) == (404, NOT_FOUND)
    assert (no_job.status_code, no_job.json()) == (404, NOT_FOUND)
    assert (unknown.status_code, unknown.json()) == (404, NOT_FOUND)
    assert (pro.status_code, pro.json()) == (403, FORBIDDEN)
    assert (staff.status_code, staff.json()) == (403, FORBIDDEN)
    assert anonymous.status_code == 401
    assert await tip_row(db_session, job) is None
    assert stripe_fake.intent_calls == []


# A tip to pay


async def test_a_percent_tip_is_charged_from_the_price_before_tax(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)

    response = await choose(db_client, world, job, PERCENT_12)

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    row = await tip_row(db_session, job)
    assert row is not None
    assert {k: body["tip"][k] for k in ("status", "choice", "percent", "amount_cents")} == {
        "status": "requires_payment",
        "choice": "percent",
        "percent": 12,
        "amount_cents": 2_400,
    }
    assert body["tip"]["can_tip"] is True
    sheet = body["sheet"]
    assert {k: sheet[k] for k in ("amount_cents", "tax_cents", "customer_total_cents")} == {
        "amount_cents": 2_400,
        "tax_cents": 0,
        "customer_total_cents": 2_400,
    }
    assert (sheet["currency"], sheet["publishable_key"]) == ("usd", PUBLISHABLE_KEY)
    assert sheet["customer_id"] == STRIPE_CUSTOMER
    [call] = stripe_fake.intent_calls
    assert call == {
        "amount_cents": 2_400,
        "currency": "usd",
        "customer_id": STRIPE_CUSTOMER,
        "transfer_group": f"request:{job.request_id}",
        "metadata": {
            "kind": "tip",
            "tip_id": str(row.id),
            "job_id": str(job.id),
            "attempt": "1",
        },
        "description": "Tip",
        "idempotency_key": f"tip:{row.id}:1",
    }
    intent = stripe_fake.intents_by_key[f"tip:{row.id}:1"]
    assert sheet["payment_intent_client_secret"] == stripe_fake.intents[intent].client_secret
    assert (row.status, row.attempt, row.stripe_payment_intent_id) == (
        TipStatus.REQUIRES_PAYMENT,
        1,
        intent,
    )
    assert row.payment_intent_requested_at is not None
    assert (row.request_id, row.customer_id, row.pro_id) == (
        job.request_id,
        world.customer.id,
        world.pro.profile_id,
    )
    assert not any(word in name for name in field_names(body) for word in SPLIT_WORDS)


async def test_a_custom_tip_is_charged_as_chosen(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)

    response = await choose(db_client, world, job, {"choice": "custom", "amount_cents": 1_250})

    assert response.status_code == 200, response.text
    tip = response.json()["tip"]
    assert (tip["choice"], tip["percent"], tip["amount_cents"]) == ("custom", None, 1_250)
    assert [call["amount_cents"] for call in stripe_fake.intent_calls] == [1_250]


async def test_the_same_choice_again_gets_the_same_intent(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)

    first = await choose(db_client, world, job, PERCENT_12)
    again = await choose(db_client, world, job, PERCENT_12)

    assert again.status_code == 200, again.text
    secret = "payment_intent_client_secret"
    assert again.json()["sheet"][secret] == first.json()["sheet"][secret]
    assert len(stripe_fake.intent_calls) == 1
    assert len(stripe_fake.retrieved) == 1
    # A new CustomerSession on every call.
    assert len(stripe_fake.customer_sessions) == 2


async def test_the_customers_stripe_customer_is_created_when_missing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    await db_session.execute(
        update(User).where(User.id == world.customer.id).values(stripe_customer_id=None)
    )

    response = await choose(db_client, world, job, PERCENT_12)

    assert response.status_code == 200, response.text
    [created] = stripe_fake.customer_calls
    assert created["idempotency_key"] == f"customer:{world.customer.id}"
    stored = await db_session.scalar(
        select(User.stripe_customer_id).where(User.id == world.customer.id)
    )
    assert (
        stored
        == response.json()["sheet"]["customer_id"]
        == stripe_fake.intent_calls[0]["customer_id"]
    )


async def test_a_new_amount_cancels_the_earlier_intent_before_a_new_one(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    await choose(db_client, world, job, PERCENT_12)
    first = await tip_row(db_session, job)
    assert first is not None
    tip_id, first_intent, version = first.id, first.stripe_payment_intent_id, first.updated_at
    assert first_intent is not None
    calls: list[str] = []

    async def cancel() -> None:
        calls.append("cancel")

    async def create() -> None:
        calls.append("create")

    stripe_fake.on_cancel_intent, stripe_fake.on_create_intent = cancel, create

    response = await choose(db_client, world, job, {"choice": "custom", "amount_cents": 1_000})

    assert response.status_code == 200, response.text
    assert calls == ["cancel", "create"]
    key = tip_cancel_idempotency_key(tip_id, 1, version)
    assert stripe_fake.cancels == [(first_intent, key)]
    assert [call["idempotency_key"] for call in stripe_fake.intent_calls] == [
        f"tip:{tip_id}:1",
        f"tip:{tip_id}:2",
    ]
    assert stripe_fake.intent_calls[1]["amount_cents"] == 1_000
    row = await tip_row(db_session, job)
    assert row is not None
    assert (row.attempt, row.amount_cents, row.choice, row.percent) == (2, 1_000, "custom", None)
    assert row.stripe_payment_intent_id == stripe_fake.intents_by_key[f"tip:{tip_id}:2"]


@pytest.mark.parametrize(
    ("stripe_status", "expected"), [("processing", IN_PROGRESS), ("succeeded", ALREADY_PAID)]
)
async def test_a_refused_cancel_changes_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
    stripe_status: str,
    expected: str,
) -> None:
    """The customer paid the first sheet while choosing another amount: Stripe refuses the
    cancel, and the paid (or paying) intent stays the tip's."""
    job = await confirmed(db_session, world)
    await choose(db_client, world, job, PERCENT_12)
    before = await tip_row(db_session, job)
    assert before is not None
    status, intent = before.status, before.stripe_payment_intent_id
    stripe_fake.cancel_refused, stripe_fake.intent_status = True, stripe_status

    response = await choose(db_client, world, job, {"choice": "custom", "amount_cents": 1_000})
    declined = await choose(db_client, world, job, {"choice": "none"})

    assert (response.status_code, code(response)) == (409, expected)
    assert (declined.status_code, code(declined)) == (409, expected)
    after = await tip_row(db_session, job)
    assert after is not None
    assert (after.attempt, after.amount_cents, after.status) == (1, 2_400, status)
    assert after.stripe_payment_intent_id == intent
    assert len(stripe_fake.intent_calls) == 1


async def test_an_intent_canceled_already_lets_the_change_through(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    await choose(db_client, world, job, PERCENT_12)
    stripe_fake.cancel_refused, stripe_fake.intent_status = True, "canceled"

    response = await choose(db_client, world, job, {"choice": "none"})

    assert response.status_code == 200, response.text
    row = await tip_row(db_session, job)
    assert row is not None
    assert (row.status, row.stripe_payment_intent_id) == (TipStatus.DECLINED, None)


# No tip


async def test_no_tip_is_declined_without_stripe(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)

    first = await choose(db_client, world, job, {"choice": "none"})
    again = await choose(db_client, world, job, {"choice": "none"})

    for response in (first, again):
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["sheet"] is None
        assert {k: body["tip"][k] for k in ("status", "choice", "percent", "amount_cents")} == {
            "status": "declined",
            "choice": "none",
            "percent": None,
            "amount_cents": 0,
        }
        # No tip now does not close the window.
        assert body["tip"]["can_tip"] is True
    assert (stripe_fake.intent_calls, stripe_fake.cancels, stripe_fake.customer_calls) == (
        [],
        [],
        [],
    )
    row = await tip_row(db_session, job)
    assert row is not None
    assert (row.attempt, row.stripe_payment_intent_id) == (0, None)


async def test_no_tip_without_stripe_configured_still_declines(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await confirmed(db_session, world)

    declined = await choose(db_client, world, job, {"choice": "none"})
    paid = await choose(db_client, world, job, PERCENT_12)

    assert declined.status_code == 200, declined.text
    assert (paid.status_code, code(paid)) == (503, "not_configured")
    row = await tip_row(db_session, job)
    assert row is not None
    assert row.status is TipStatus.DECLINED


async def test_no_tip_after_an_amount_cancels_its_intent(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    await choose(db_client, world, job, PERCENT_12)
    first = await tip_row(db_session, job)
    assert first is not None
    intent = first.stripe_payment_intent_id

    response = await choose(db_client, world, job, {"choice": "none"})

    assert response.status_code == 200, response.text
    assert [canceled for canceled, _ in stripe_fake.cancels] == [intent]
    row = await tip_row(db_session, job)
    assert row is not None
    assert (row.status, row.amount_cents, row.stripe_payment_intent_id) == (
        TipStatus.DECLINED,
        0,
        None,
    )


async def test_a_tip_after_no_tip_starts_its_first_attempt(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    await choose(db_client, world, job, {"choice": "none"})

    response = await choose(db_client, world, job, PERCENT_12)

    assert response.status_code == 200, response.text
    row = await tip_row(db_session, job)
    assert row is not None
    assert [call["idempotency_key"] for call in stripe_fake.intent_calls] == [f"tip:{row.id}:1"]
    assert stripe_fake.cancels == []


# The tip's state


@pytest.mark.parametrize(
    ("status", "expected"),
    [(TipStatus.SUCCEEDED, ALREADY_PAID), (TipStatus.PROCESSING, IN_PROGRESS)],
)
async def test_a_paid_or_paying_tip_is_never_changed(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
    status: TipStatus,
    expected: str,
) -> None:
    job = await confirmed(db_session, world)
    await choose(db_client, world, job, PERCENT_12)
    succeeded_at = func.now() if status is TipStatus.SUCCEEDED else None
    await set_tip(db_session, job, status=status, succeeded_at=succeeded_at)

    responses = [
        await choose(db_client, world, job, body)
        for body in (PERCENT_12, {"choice": "custom", "amount_cents": 1_000}, {"choice": "none"})
    ]

    assert [(r.status_code, code(r)) for r in responses] == [(409, expected)] * 3
    assert (await job_view(db_client, world, job))["tip"]["can_tip"] is False
    assert (len(stripe_fake.intent_calls), stripe_fake.cancels) == (1, [])


async def test_a_failed_tip_is_paid_again_with_the_same_intent(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    await choose(db_client, world, job, PERCENT_12)
    await set_tip(db_session, job, status=TipStatus.FAILED)

    response = await choose(db_client, world, job, PERCENT_12)

    assert response.status_code == 200, response.text
    assert response.json()["tip"]["status"] == "requires_payment"
    row = await tip_row(db_session, job)
    assert row is not None
    assert (row.status, row.attempt) == (TipStatus.REQUIRES_PAYMENT, 1)
    assert (len(stripe_fake.intent_calls), stripe_fake.cancels) == (1, [])


async def test_a_canceled_tip_gets_a_new_attempt(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    await choose(db_client, world, job, PERCENT_12)
    await set_tip(db_session, job, status=TipStatus.CANCELED)

    response = await choose(db_client, world, job, PERCENT_12)

    assert response.status_code == 200, response.text
    row = await tip_row(db_session, job)
    assert row is not None
    assert (row.status, row.attempt) == (TipStatus.REQUIRES_PAYMENT, 2)
    assert [call["idempotency_key"] for call in stripe_fake.intent_calls] == [
        f"tip:{row.id}:1",
        f"tip:{row.id}:2",
    ]
    assert stripe_fake.cancels == []


# Bounds and the body


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"choice": "custom", "amount_cents": MIN_CENTS - 1}, OUT_OF_RANGE),
        ({"choice": "custom", "amount_cents": CAP_CENTS + 1}, OUT_OF_RANGE),
        ({"choice": "custom", "amount_cents": 0}, OUT_OF_RANGE),
        ({"choice": "custom", "amount_cents": -500}, OUT_OF_RANGE),
        ({"choice": "percent", "percent": 7}, NOT_OFFERED),
        ({"choice": "percent", "percent": 0}, NOT_OFFERED),
        ({"choice": "percent", "percent": MAX_PERCENT}, NOT_OFFERED),
        ({"choice": "custom", "amount_cents": "1250"}, "validation_error"),
        ({"choice": "custom", "amount_cents": 12.5}, "validation_error"),
        ({"choice": "custom", "amount_cents": True}, "validation_error"),
        ({"choice": "percent", "percent": 12, "amount_cents": 2_400}, "validation_error"),
        ({"choice": "none", "amount_cents": 0}, "validation_error"),
        ({"choice": "tip"}, "validation_error"),
        ({}, "validation_error"),
    ],
)
async def test_a_choice_outside_the_options_is_refused(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
    body: dict[str, object],
    expected: str,
) -> None:
    job = await confirmed(db_session, world)

    response = await choose(db_client, world, job, body)

    assert (response.status_code, code(response)) == (422, expected)
    assert await tip_row(db_session, job) is None
    assert stripe_fake.intent_calls == []


async def test_an_offered_percent_outside_this_jobs_bounds_is_refused(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world, price=2_000)  # 6% is 120

    response = await choose(db_client, world, job, {"choice": "percent", "percent": 6})

    assert (response.status_code, code(response)) == (422, OUT_OF_RANGE)
    assert stripe_fake.intent_calls == []


# Stripe's failures


async def test_a_lost_create_answer_is_replayed_with_the_same_key(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    stripe_fake.lost_answers = 1

    lost = await choose(db_client, world, job, PERCENT_12)
    row = await tip_row(db_session, job)
    assert row is not None
    tip_id, kept = row.id, (row.stripe_payment_intent_id, row.payment_intent_requested_at)
    retry = await choose(db_client, world, job, PERCENT_12)

    assert (lost.status_code, code(lost)) == (503, "payments_unavailable")
    assert kept[0] is None
    assert kept[1] is not None
    assert retry.status_code == 200, retry.text
    keys = [call["idempotency_key"] for call in stripe_fake.intent_calls]
    assert keys == [f"tip:{tip_id}:1"] * 2
    after = await tip_row(db_session, job)
    assert after is not None
    assert after.stripe_payment_intent_id == stripe_fake.intents_by_key[f"tip:{tip_id}:1"]


async def test_a_change_waits_while_a_create_may_still_answer(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    stripe_fake.lost_answers = 1
    await choose(db_client, world, job, PERCENT_12)

    changed = await choose(db_client, world, job, {"choice": "custom", "amount_cents": 1_000})
    declined = await choose(db_client, world, job, {"choice": "none"})

    assert [(r.status_code, code(r)) for r in (changed, declined)] == [(409, IN_PROGRESS)] * 2
    row = await tip_row(db_session, job)
    assert row is not None
    assert (row.attempt, row.amount_cents, row.status) == (1, 2_400, TipStatus.REQUIRES_PAYMENT)
    assert len(stripe_fake.intent_calls) == 1


async def test_a_create_lost_past_the_window_is_found_again_and_kept(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    """#510 round 1 (Vault B1): Stripe may have forgotten the key, so the intent is found by
    its metadata, checked and adopted: the same attempt, no second intent."""
    job = await confirmed(db_session, world)
    stripe_fake.lost_answers = 1
    await choose(db_client, world, job, PERCENT_12)
    await set_tip(
        db_session,
        job,
        payment_intent_requested_at=datetime.now(UTC) - RECONCILE - timedelta(minutes=1),
    )

    response = await choose(db_client, world, job, PERCENT_12)

    assert response.status_code == 200, response.text
    row = await tip_row(db_session, job)
    assert row is not None
    [made] = stripe_fake.intents_by_key.values()
    assert (row.attempt, row.stripe_payment_intent_id) == (1, made)
    assert response.json()["sheet"]["payment_intent_client_secret"] == (
        stripe_fake.intents[made].client_secret
    )
    assert stripe_fake.tip_searches == [row.id]
    assert len(stripe_fake.intents) == 1


@pytest.mark.parametrize("search", ["empty", "incomplete", "foreign_job"])
async def test_a_create_lost_past_the_window_that_stripe_cannot_place_stays_blocked(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
    caplog: pytest.LogCaptureFixture,
    search: str,
) -> None:
    """Never a replacement on age alone: until Stripe shows the intent, the tip waits for
    staff (409 tip_needs_review), every choice alike, and nothing is created or canceled."""
    job = await confirmed(db_session, world)
    stripe_fake.lost_answers = 1
    await choose(db_client, world, job, PERCENT_12)
    await set_tip(
        db_session,
        job,
        payment_intent_requested_at=datetime.now(UTC) - RECONCILE - timedelta(minutes=1),
    )
    [made] = stripe_fake.intents_by_key.values()
    if search == "empty":
        stripe_fake.tip_facts.clear()
    elif search == "incomplete":
        stripe_fake.search_complete = False
    else:
        stripe_fake.tip_facts[made] = dataclasses.replace(
            stripe_fake.tip_facts[made], job_id=str(uuid.uuid4())
        )

    answers = [
        await choose(db_client, world, job, body)
        for body in (PERCENT_12, {"choice": "custom", "amount_cents": 1_000}, {"choice": "none"})
    ]

    assert [(r.status_code, code(r)) for r in answers] == [(409, NEEDS_REVIEW)] * 3
    row = await tip_row(db_session, job)
    assert row is not None
    assert (row.attempt, row.stripe_payment_intent_id, row.status) == (
        1,
        None,
        TipStatus.REQUIRES_PAYMENT,
    )
    assert len(stripe_fake.intent_calls) == 1
    assert stripe_fake.cancels == []
    assert [r.message for r in caplog.records].count("tip_intent_unresolved") == 3


async def test_a_found_intent_stripe_canceled_lets_a_new_attempt_start(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    stripe_fake.lost_answers = 1
    await choose(db_client, world, job, PERCENT_12)
    await set_tip(
        db_session,
        job,
        payment_intent_requested_at=datetime.now(UTC) - RECONCILE - timedelta(minutes=1),
    )
    [made] = stripe_fake.intents_by_key.values()
    stripe_fake.tip_statuses[made] = "canceled"

    response = await choose(db_client, world, job, PERCENT_12)

    assert response.status_code == 200, response.text
    row = await tip_row(db_session, job)
    assert row is not None
    assert row.attempt == 2
    assert [call["idempotency_key"] for call in stripe_fake.intent_calls] == [
        f"tip:{row.id}:1",
        f"tip:{row.id}:2",
    ]


@pytest.mark.parametrize(
    ("code_sent", "attempt_after"),
    [("amount_too_small", 2), ("parameter_unknown", 1), ("api_key_expired", 1)],
)
async def test_only_a_definitive_create_refusal_lets_a_new_attempt_start(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
    code_sent: str,
    attempt_after: int,
) -> None:
    """A refusal of the shared kind (an explicit list of codes) proves nothing was made under
    the key: the next choice asks for a new attempt. Any other refusal says nothing: the next
    choice sends the same key again."""
    job = await confirmed(db_session, world)
    stripe_fake.errors["create_payment_intent"] = StripeRejectedError(
        request_id="req_x", code=code_sent
    )
    refused = await choose(db_client, world, job, PERCENT_12)
    del stripe_fake.errors["create_payment_intent"]

    retried = await choose(db_client, world, job, PERCENT_12)

    assert (refused.status_code, code(refused)) == (502, "payments_error")
    assert retried.status_code == 200, retried.text
    row = await tip_row(db_session, job)
    assert row is not None
    assert row.attempt == attempt_after
    assert stripe_fake.intent_calls[-1]["idempotency_key"] == f"tip:{row.id}:{attempt_after}"


async def test_a_tip_flagged_for_a_late_success_takes_no_choice(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    await choose(db_client, world, job, PERCENT_12)
    await set_tip(db_session, job, late_success_at=func.now())

    answers = [
        await choose(db_client, world, job, body) for body in (PERCENT_12, {"choice": "none"})
    ]

    assert [(r.status_code, code(r)) for r in answers] == [(409, NEEDS_REVIEW)] * 2
    assert len(stripe_fake.intent_calls) == 1
    assert stripe_fake.cancels == []


# --- The Idempotency-Key (#510 round 1, Gatekeeper B1) --------------------------------------


async def test_a_replayed_no_tip_never_cancels_a_newer_choice(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    """The Gatekeeper's history: "No tip" with key A, a percent with key B, then A again."""
    job = await confirmed(db_session, world)
    key_a, key_b = uuid.uuid4(), uuid.uuid4()

    declined = await choose(db_client, world, job, {"choice": "none"}, key=key_a)
    paid = await choose(db_client, world, job, PERCENT_12, key=key_b)
    replay_a = await choose(db_client, world, job, {"choice": "none"}, key=key_a)
    replay_b = await choose(db_client, world, job, PERCENT_12, key=key_b)

    assert [r.status_code for r in (declined, paid, replay_a, replay_b)] == [200] * 4
    # A's replay shows the tip as it is now and changes nothing: no cancel, no sheet.
    assert replay_a.json()["sheet"] is None
    assert replay_a.json()["tip"]["status"] == "requires_payment"
    assert stripe_fake.cancels == []
    # B's replay shows B's own sheet again: the same intent, no second one.
    secret = "payment_intent_client_secret"
    assert replay_b.json()["sheet"][secret] == paid.json()["sheet"][secret]
    assert len(stripe_fake.intent_calls) == 1
    row = await tip_row(db_session, job)
    assert row is not None
    assert (row.status, row.attempt, row.percent) == (TipStatus.REQUIRES_PAYMENT, 1, 12)


async def test_a_replay_after_the_tip_succeeded_answers_the_tip(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    key = uuid.uuid4()
    await choose(db_client, world, job, PERCENT_12, key=key)
    await set_tip(db_session, job, status=TipStatus.SUCCEEDED, succeeded_at=func.now())

    replay = await choose(db_client, world, job, PERCENT_12, key=key)
    unkeyed = await choose(db_client, world, job, PERCENT_12)

    assert replay.status_code == 200, replay.text
    assert (replay.json()["tip"]["status"], replay.json()["sheet"]) == ("succeeded", None)
    # Without the key it is a new choice: the tip is paid.
    assert (unkeyed.status_code, code(unkeyed)) == (409, ALREADY_PAID)


async def test_a_key_reused_with_another_body_or_job_is_refused(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    other_job = await confirmed(db_session, world)
    key = uuid.uuid4()
    await choose(db_client, world, job, PERCENT_12, key=key)

    other_body = await choose(db_client, world, job, {"choice": "none"}, key=key)
    other_job_answer = await choose(db_client, world, other_job, PERCENT_12, key=key)

    for answer in (other_body, other_job_answer):
        assert (answer.status_code, code(answer)) == (409, "idempotency_key_reused")
    assert await tip_row(db_session, other_job) is None
    assert stripe_fake.cancels == []
    assert len(stripe_fake.intent_calls) == 1


async def test_a_keyed_choice_that_failed_is_done_by_its_retry(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    """A choice that failed records nothing: its retry with the same key does the work."""
    job = await confirmed(db_session, world)
    key = uuid.uuid4()
    stripe_fake.errors["create_customer_session"] = StripeUnavailableError(request_id="req_x")
    failed = await choose(db_client, world, job, PERCENT_12, key=key)
    del stripe_fake.errors["create_customer_session"]

    retried = await choose(db_client, world, job, PERCENT_12, key=key)

    assert (failed.status_code, code(failed)) == (503, "payments_unavailable")
    assert retried.status_code == 200, retried.text
    assert retried.json()["sheet"] is not None
    assert len(stripe_fake.intent_calls) == 1


async def test_another_customer_s_key_is_just_a_new_key(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    key = uuid.uuid4()
    await choose(db_client, world, job, PERCENT_12, key=key)

    other = await choose(
        db_client, world, job, PERCENT_12, key=key, headers=world.other_customer.headers
    )

    assert (other.status_code, other.json()) == (404, NOT_FOUND)


# --- The rate limit (#510 round 1, Vault B3) ------------------------------------------------


class DenyingLimiter:
    """Refuses every hit, and records each."""

    def __init__(self) -> None:
        self.hits: list[tuple[str, str, int, int]] = []

    async def hit(
        self, scope: str, identifier: str, *, limit: int, window_seconds: int
    ) -> RateLimitResult:
        self.hits.append((scope, identifier, limit, window_seconds))
        return RateLimitResult(allowed=False, retry_after_seconds=9)


async def test_a_refused_hit_stops_the_choice_before_stripe(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
    settings: Settings,
) -> None:
    limiter = DenyingLimiter()
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    job = await confirmed(db_session, world)

    response = await choose(db_client, world, job, PERCENT_12, key=uuid.uuid4())

    assert (response.status_code, code(response)) == (429, "rate_limited")
    assert response.headers["retry-after"] == "9"
    assert response.headers["cache-control"] == "no-store"
    assert limiter.hits == [
        (
            "tip_choice",
            str(world.customer.id),
            settings.tip_choice_limit,
            settings.tip_choice_window_seconds,
        )
    ]
    assert (stripe_fake.intent_calls, stripe_fake.customer_sessions) == ([], [])
    assert await tip_row(db_session, job) is None


async def test_choices_are_limited_per_customer_and_replays_count(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    limiter = InMemoryRateLimiter(clock=lambda: 1_000_000.0)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    job = await confirmed(db_session, world)
    key = uuid.uuid4()
    limit = 3

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(app.state.settings, "tip_choice_limit", limit)
        answers = [
            await choose(db_client, world, job, PERCENT_12, key=key) for _ in range(limit + 1)
        ]
        other = await choose(
            db_client, world, job, PERCENT_12, headers=world.other_customer.headers
        )

    assert [r.status_code for r in answers] == [200] * limit + [429]
    # Another customer has their own count (the job is not theirs: 404, never 429).
    assert other.status_code == 404


async def test_stripe_unavailable_on_the_cancel_changes_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    await choose(db_client, world, job, PERCENT_12)
    stripe_fake.errors["cancel_payment_intent"] = StripeUnavailableError(request_id="req_x")

    response = await choose(db_client, world, job, {"choice": "custom", "amount_cents": 1_000})

    assert (response.status_code, code(response)) == (503, "payments_unavailable")
    row = await tip_row(db_session, job)
    assert row is not None
    assert (row.attempt, row.amount_cents) == (1, 2_400)


# Confirmation is never coupled to a tip


async def test_confirming_never_reads_or_writes_a_tip(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    record_pushes(app)
    job = await committed_ref(
        db_session,
        await make_job(db_session, world, JobStatus.COMPLETED, completed_at=datetime.now(UTC)),
    )
    stripe_fake.errors.update(
        {name: StripeUnavailableError(request_id="req_x") for name in ("create_payment_intent",)}
    )

    response = await db_client.post(
        f"/v1/requests/{job.request_id}/job/confirm", headers=world.customer.headers
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "confirmed"
    assert (body["tip"]["status"], body["tip"]["can_tip"]) == (None, True)
    assert await tip_row(db_session, job) is None
    assert stripe_fake.intent_calls == []
    assert stripe_fake.customer_sessions == []


# Logs


async def test_tip_logs_carry_ids_only(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    job = await confirmed(db_session, world)
    first = await choose(db_client, world, job, PERCENT_12)
    second = await choose(db_client, world, job, {"choice": "custom", "amount_cents": 1_000})
    stripe_fake.errors["create_customer_session"] = StripeUnavailableError(request_id="req_y")
    await choose(db_client, world, job, {"choice": "custom", "amount_cents": 1_000})

    tip_records = [r for r in caplog.records if r.message.startswith("tip_")]
    assert {r.message for r in tip_records} >= {
        "tip_payment_intent_created",
        "tip_sheet_issued",
        "tip_intent_canceled_for_change",
        "tip_chosen",
        "tip_stripe_unavailable",
    }
    text = "\n".join(JsonFormatter().format(r) for r in caplog.records)
    secrets = [
        *(
            r.json()["sheet"][k]
            for r in (first, second)
            for k in (
                "payment_intent_client_secret",
                "customer_session_client_secret",
                "ephemeral_key_secret",
            )
        ),
        *stripe_fake.intents,
        STRIPE_CUSTOMER,
    ]
    assert not [secret for secret in secrets if secret in text]
    for record in tip_records:
        assert set(extra_of(record)) <= {
            "tip_id",
            "job_id",
            "service_request_id",
            "user_id",
            "choice",
            "operation",
            "stripe_request_id",
            "stripe_code",
            "intent_status",
        }, record.message
    assert json.loads(JsonFormatter().format(tip_records[0]))["tip_id"]


# --- #510 self-review: the key is stored with the change it settles -------------------------


CUSTOM_10 = {"choice": "custom", "amount_cents": 1_000}


async def test_a_keyed_choice_whose_sheet_failed_never_undoes_a_newer_choice(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    """The self-review's case: K1 settled 12 % and its intent, then its sheet failed; K2 chose
    another amount; K1's late retry answers the tip as it is now and cancels nothing."""
    job = await confirmed(db_session, world)
    key_1, key_2 = uuid.uuid4(), uuid.uuid4()
    stripe_fake.errors["create_customer_session"] = StripeUnavailableError(request_id="req_x")
    failed = await choose(db_client, world, job, PERCENT_12, key=key_1)
    del stripe_fake.errors["create_customer_session"]
    [first] = stripe_fake.intents_by_key.values()

    newer = await choose(db_client, world, job, CUSTOM_10, key=key_2)
    late = await choose(db_client, world, job, PERCENT_12, key=key_1)

    assert (failed.status_code, code(failed)) == (503, "payments_unavailable")
    assert newer.status_code == 200, newer.text
    assert late.status_code == 200, late.text
    assert late.json()["sheet"] is None
    assert late.json()["tip"]["amount_cents"] == 1_000
    # Only the first intent was ever canceled (by the newer choice), never the newer one.
    assert [intent for intent, _ in stripe_fake.cancels] == [first]
    assert len(stripe_fake.intent_calls) == 2
    row = await tip_row(db_session, job)
    assert row is not None
    assert (row.amount_cents, row.status) == (1_000, TipStatus.REQUIRES_PAYMENT)


async def test_a_failed_keyed_choice_keeps_its_key_for_its_own_body(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    key = uuid.uuid4()
    stripe_fake.errors["create_customer_session"] = StripeUnavailableError(request_id="req_x")
    await choose(db_client, world, job, PERCENT_12, key=key)
    del stripe_fake.errors["create_customer_session"]

    other = await choose(db_client, world, job, CUSTOM_10, key=key)

    assert (other.status_code, code(other)) == (409, "idempotency_key_reused")
    assert stripe_fake.cancels == []


async def test_a_keyed_create_that_failed_resumes_under_the_same_stripe_key(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
) -> None:
    job = await confirmed(db_session, world)
    key = uuid.uuid4()
    stripe_fake.errors["create_payment_intent"] = StripeUnavailableError(request_id="req_x")
    failed = await choose(db_client, world, job, PERCENT_12, key=key)
    del stripe_fake.errors["create_payment_intent"]

    retried = await choose(db_client, world, job, PERCENT_12, key=key)

    assert failed.status_code == 503
    assert retried.status_code == 200, retried.text
    assert retried.json()["sheet"] is not None
    row = await tip_row(db_session, job)
    assert row is not None
    # The same attempt, so the same Stripe key: Stripe replays a create it made.
    assert row.attempt == 1
    assert [call["idempotency_key"] for call in stripe_fake.intent_calls] == [f"tip:{row.id}:1"]


# --- #510 self-review: staff's way out of a lost create Stripe never made ------------------


async def lost_create(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
    age: timedelta,
) -> JobRef:
    """A tip whose create Stripe never made (nothing under its key), sent `age` ago."""
    job = await confirmed(db_session, world)
    stripe_fake.errors["create_payment_intent"] = StripeUnavailableError(request_id="req_x")
    await choose(db_client, world, job, PERCENT_12)
    del stripe_fake.errors["create_payment_intent"]
    await set_tip(db_session, job, payment_intent_requested_at=datetime.now(UTC) - age)
    return job


async def resolve_tip(
    db_session: AsyncSession, settings: Settings, tip_id: uuid.UUID, *extra: str
) -> tuple[int, str]:
    out = io.StringIO()
    argv = ["--tip", str(tip_id), "--allow-new", "--operator", OPERATOR_EMAIL, "--yes", *extra]
    exit_code = await resolve_tip_intent.run(
        argv, sessions_of(db_session), settings, resolve_tip_intent.Io(out=out)
    )
    return exit_code, out.getvalue()


async def test_staff_clear_a_lost_create_stripe_never_made_and_the_customer_chooses_again(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
    settings: Settings,
) -> None:
    operator = await make_staff(db_session)
    await db_session.commit()
    job = await lost_create(db_client, db_session, world, stripe_fake, timedelta(hours=25))
    stuck = await choose(db_client, world, job, {"choice": "none"})
    row = await tip_row(db_session, job)
    assert row is not None
    tip_id, attempt = row.id, row.attempt

    exit_code, printed = await resolve_tip(db_session, settings, tip_id, "--reason", "probe")
    after = await choose(db_client, world, job, {"choice": "none"})

    assert (stuck.status_code, code(stuck)) == (409, NEEDS_REVIEW)
    assert exit_code == 0, printed
    assert f"Tip {tip_id} can take a new choice." in printed
    assert after.status_code == 200, after.text
    assert after.json()["tip"]["status"] == "declined"
    [audit] = [r for r in await audit_rows(db_session) if r.action == "tip.allow_new_intent"]
    assert (audit.actor_user_id, audit.entity_type, audit.entity_id) == (operator, "tip", tip_id)
    assert audit.before["attempt"] == attempt
    assert audit.after["payment_intent_requested_at"] is None


@pytest.mark.parametrize("case", ["young", "has_intent", "no_create", "unknown", "not_admin"])
async def test_staff_recovery_is_refused_and_changes_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe_fake: FakeStripePayments,
    settings: Settings,
    case: str,
) -> None:
    await make_staff(db_session, role=UserRole.AGENT if case == "not_admin" else UserRole.ADMIN)
    await db_session.commit()
    age = timedelta(hours=23) if case == "young" else timedelta(hours=25)
    job = await lost_create(db_client, db_session, world, stripe_fake, age)
    if case == "has_intent":
        await set_tip(db_session, job, stripe_payment_intent_id="pi_resolvetipfixture")
    elif case == "no_create":
        await set_tip(db_session, job, payment_intent_requested_at=None)
    row = await tip_row(db_session, job)
    assert row is not None
    tip_id = uuid.uuid4() if case == "unknown" else row.id
    before = row.payment_intent_requested_at

    exit_code, printed = await resolve_tip(db_session, settings, tip_id)

    assert exit_code == 1
    assert printed.startswith("Error: ")
    assert "pi_" not in printed
    after = await tip_row(db_session, job)
    assert after is not None
    assert after.payment_intent_requested_at == before
    assert [r for r in await audit_rows(db_session) if r.action == "tip.allow_new_intent"] == []
