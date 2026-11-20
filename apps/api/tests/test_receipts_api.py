"""GET /v1/requests/{request_id}/receipt (#62, PR C): the job's receipt, from frozen rows.

On the rolled-back test session. The job world's price (20,000), tax (1,400), payout (17,000)
and fee (3,000) all differ, so a line or a total taken from the wrong one shows.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import httpx
import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.disputes.models import Dispute, DisputeReason
from app.modules.jobs.models import Job, JobStatus
from app.modules.payments.models import Payment, Refund, RefundStatus
from app.modules.tips.models import Tip, TipChoice, TipStatus
from tests.conftest import make_settings
from tests.job_world import (
    CUSTOMER_EMAIL,
    CUSTOMER_PHONE,
    FEE,
    LINE1,
    LINE2,
    PAYOUT,
    PRICE,
    START,
    TAX,
    JobWorld,
    build_world,
    make_accepted_request,
    make_job,
)
from tests.test_payments_api import field_names
from tests.test_transfers import add_payment

NOT_FOUND: Final = {"error": {"code": "not_found", "message": "Resource not found."}}
NOT_AVAILABLE: Final = {
    "error": {
        "code": "receipt_not_available",
        "message": "There is no receipt for this request yet.",
    }
}
FORBIDDEN: Final = {
    "error": {"code": "forbidden", "message": "You do not have access to this resource."}
}
# What only the platform or the pro may see: never in the receipt or its schema.
INTERNAL_WORDS: Final = ("fee", "payout", "take_rate", "stripe")
TIP: Final = 2_400


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        receipt_legal_name="Fixture Legal Name LLC",
        receipt_support_email="support@fixture.invalid",
    )


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


async def paid_job(
    session: AsyncSession,
    world: JobWorld,
    status: JobStatus = JobStatus.CONFIRMED,
    **payment: Any,
) -> tuple[Job, Payment]:
    at = datetime.now(UTC) - timedelta(hours=1)
    job = await make_job(session, world, status, completed_at=at, confirmed_at=at)
    paid = await add_payment(session, world, job, **payment)
    return job, paid


async def receipt(
    client: httpx.AsyncClient, world: JobWorld, job: Job, headers: dict[str, str] | None = None
) -> httpx.Response:
    return await client.get(
        f"/v1/requests/{job.request_id}/receipt", headers=headers or world.customer.headers
    )


async def add_refund(
    session: AsyncSession,
    job: Job,
    payment: Payment,
    amount: int,
    stripe_status: str | None,
    status: RefundStatus = RefundStatus.CREATED,
    at: datetime | None = None,
) -> Refund:
    refund = Refund(
        job_id=job.id,
        payment_id=payment.id,
        amount_cents=amount,
        currency="usd",
        idempotency_key=f"cancel:{uuid.uuid4()}:refund",
        status=status,
        stripe_refund_id=None if stripe_status is None else f"re_r62{uuid.uuid4().hex[:10]}",
        stripe_status=stripe_status,
        requested_at=at or datetime.now(UTC),
    )
    session.add(refund)
    await session.flush()
    return refund


async def add_tip(
    session: AsyncSession, world: JobWorld, job: Job, status: TipStatus = TipStatus.SUCCEEDED
) -> Tip:
    tip = Tip(
        job_id=job.id,
        request_id=job.request_id,
        customer_id=world.customer.id,
        pro_id=world.pro.profile_id,
        choice=TipChoice.CUSTOM,
        amount_cents=TIP,
        currency="usd",
        status=status,
        succeeded_at=datetime.now(UTC) if status is TipStatus.SUCCEEDED else None,
        stripe_payment_intent_id=f"pi_r62tip{uuid.uuid4().hex[:8]}",
        attempt=1,
    )
    session.add(tip)
    await session.flush()
    return tip


def kinds(body: dict[str, Any]) -> list[tuple[str, int]]:
    return [(line["kind"], line["amount_cents"]) for line in body["lines"]]


# --- The receipt ------------------------------------------------------------------------------


async def test_the_receipt_is_built_from_the_frozen_rows(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job, _ = await paid_job(db_session, world)

    response = await receipt(db_client, world, job)

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert kinds(body) == [("service", PRICE), ("tax", TAX)]
    assert body["total_paid_cents"] == PRICE + TAX
    assert (body["status"], body["currency"]) == ("paid", "usd")
    assert body["receipt_number"].startswith("JF-")
    assert datetime.fromisoformat(body["paid_at"]) == job.created_at
    assert datetime.fromisoformat(body["scheduled_start_at"]) == START
    assert datetime.fromisoformat(body["completed_at"]) == job.completed_at
    assert body["category"]["names"] == {"en": "Plumbing", "es": "Plomería"}
    assert body["pro_name"] == "María P."
    assert body["address"] == {"line1": LINE1, "city": "Orlando", "state": "FL"}
    # Not read from Stripe yet: the app says Card.
    assert body["payment_method"] is None
    assert body["tip"]["can_tip"] is True
    assert body["issuer"] == {
        "legal_name": "Fixture Legal Name LLC",
        "support_email": "support@fixture.invalid",
    }
    # Never the platform's fee, the pro's payout or a Stripe id.
    assert not any(word in name for name in field_names(body) for word in INTERNAL_WORDS)
    for leak in (str(FEE), str(PAYOUT), "pi_probe68", LINE2, CUSTOMER_EMAIL, CUSTOMER_PHONE):
        assert leak not in response.text, leak


async def test_a_tax_of_0_has_no_line(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job, _ = await paid_job(db_session, world, tax_cents=0, customer_total_cents=PRICE)

    body = (await receipt(db_client, world, job)).json()

    assert kinds(body) == [("service", PRICE)]
    assert body["total_paid_cents"] == PRICE


async def test_the_card_is_shown_once_stored(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job, _ = await paid_job(
        db_session, world, card_brand="visa", card_last4="4242", wallet="apple_pay"
    )

    body = (await receipt(db_client, world, job)).json()

    assert body["payment_method"] == {"brand": "visa", "last4": "4242", "wallet": "apple_pay"}


@pytest.mark.parametrize(
    ("status", "listed"),
    [
        (TipStatus.SUCCEEDED, True),
        (TipStatus.REQUIRES_PAYMENT, False),
        (TipStatus.PROCESSING, False),
        (TipStatus.FAILED, False),
    ],
)
async def test_a_tip_is_a_line_once_it_succeeded(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    status: TipStatus,
    listed: bool,
) -> None:
    job, _ = await paid_job(db_session, world)
    await add_tip(db_session, world, job, status)

    body = (await receipt(db_client, world, job)).json()

    tip = [("tip", TIP)] if listed else []
    assert kinds(body) == [("service", PRICE), ("tax", TAX), *tip]
    assert body["total_paid_cents"] == PRICE + TAX + (TIP if listed else 0)
    # A paid tip closes the job's tip.
    assert body["tip"]["can_tip"] is (status in (TipStatus.REQUIRES_PAYMENT, TipStatus.FAILED))


async def test_only_money_stripe_returned_is_a_line(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job, payment = await paid_job(db_session, world, JobStatus.PAID_OUT)
    returned_at = datetime(2030, 2, 1, 12, 0, tzinfo=UTC)
    await add_refund(db_session, job, payment, 5_000, "succeeded", at=returned_at)
    # None of these went back: not on the receipt.
    await add_refund(db_session, job, payment, 111, "pending")
    await add_refund(db_session, job, payment, 222, "failed")
    await add_refund(db_session, job, payment, 333, "canceled")
    await add_refund(db_session, job, payment, 444, None, RefundStatus.PENDING)
    await add_refund(db_session, job, payment, 555, "succeeded", RefundStatus.ABANDONED)

    body = (await receipt(db_client, world, job)).json()

    assert kinds(body) == [("service", PRICE), ("tax", TAX), ("returned", -5_000)]
    [returned] = [line for line in body["lines"] if line["kind"] == "returned"]
    assert datetime.fromisoformat(returned["at"]) == returned_at
    assert body["total_paid_cents"] == PRICE + TAX - 5_000
    assert body["status"] == "partly_returned"


async def test_everything_returned_reads_returned_with_nothing_paid(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job, payment = await paid_job(db_session, world, JobStatus.REFUNDED)
    await add_refund(db_session, job, payment, PRICE + TAX, "succeeded")

    body = (await receipt(db_client, world, job)).json()

    assert (body["status"], body["total_paid_cents"]) == ("returned", 0)
    # A refunded job takes no tip.
    assert body["tip"] is None


async def test_an_open_problem_reads_under_review(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job, _ = await paid_job(db_session, world, JobStatus.DISPUTED)
    db_session.add(
        Dispute(
            job_id=job.id,
            opened_by=world.customer.id,
            reason_code=next(iter(DisputeReason)),
            description="It leaks again",
        )
    )
    await db_session.flush()

    body = (await receipt(db_client, world, job)).json()

    assert (body["status"], body["total_paid_cents"]) == ("under_review", PRICE + TAX)


@pytest.mark.parametrize(
    "settings",
    [
        make_settings(receipt_legal_name="Fixture Legal Name LLC"),
        make_settings(receipt_support_email="support@fixture.invalid"),
        make_settings(),
    ],
)
async def test_the_issuer_needs_both_values_set(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job, _ = await paid_job(db_session, world)

    assert (await receipt(db_client, world, job)).json()["issuer"] is None


# --- Who reads it, and when ---------------------------------------------------------------


async def test_only_the_request_s_customer_reads_it_once_paid(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job, _ = await paid_job(db_session, world)
    unpaid = await make_job(db_session, world, JobStatus.SCHEDULED)
    no_job, _ = await make_accepted_request(db_session, world, world.pro)

    other = await receipt(db_client, world, job, world.other_customer.headers)
    pro = await receipt(db_client, world, job, world.pro.headers)
    staff = await receipt(db_client, world, job, world.admin.headers)
    anonymous = await db_client.get(f"/v1/requests/{job.request_id}/receipt")
    not_paid = await receipt(db_client, world, unpaid)
    not_booked = await db_client.get(
        f"/v1/requests/{no_job.id}/receipt", headers=world.customer.headers
    )
    unknown = await db_client.get(
        f"/v1/requests/{uuid.uuid4()}/receipt", headers=world.customer.headers
    )

    assert (other.status_code, other.json()) == (404, NOT_FOUND)
    assert (unknown.status_code, unknown.json()) == (404, NOT_FOUND)
    assert (pro.status_code, pro.json()) == (403, FORBIDDEN)
    assert (staff.status_code, staff.json()) == (403, FORBIDDEN)
    assert anonymous.status_code == 401
    # A job whose payment row is not there (or did not succeed), and a request with no job.
    assert (not_paid.status_code, not_paid.json()) == (404, NOT_AVAILABLE)
    assert (not_booked.status_code, not_booked.json()) == (404, NOT_AVAILABLE)
    for answer in (other, pro, not_paid):
        assert answer.headers["cache-control"] == "no-store"


async def test_a_payment_that_did_not_succeed_has_no_receipt(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job, payment = await paid_job(db_session, world)
    await db_session.execute(
        update(Payment).where(Payment.id == payment.id).values(status="canceled")
    )

    response = await receipt(db_client, world, job)

    assert (response.status_code, response.json()) == (404, NOT_AVAILABLE)
