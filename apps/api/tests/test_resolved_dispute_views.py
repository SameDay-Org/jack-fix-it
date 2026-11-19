"""What each side reads once a reported problem is resolved (#472, #488; Foreman 2026-11-19).

The customer: needs attention only while the dispute is open; completed once an admin resolved
it, whatever the pro's transfer; cancelled for a full refund; and on their report, what came
back. The pro: what they will actually receive, never the customer's money. Admin resolutions
run through the API with Stripe faked (tests/test_dispute_resolution_api.py)."""

from typing import Any

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.models import JobStatus
from app.modules.jobs.transitions import CUSTOMER_STATUS
from tests.job_world import PAYOUT, JobWorld, job_row
from tests.job_world import make_job as make_world_job
from tests.test_dispute_resolution_api import (
    ODD_REFUND,
    ODD_RELEASE,
    TOTAL,
    Case,
    FakeStripeRefunds,
    disputed,
    resolve,
)

# The resolution tests' fixtures, used here by name.
from tests.test_dispute_resolution_api import clock as clock
from tests.test_dispute_resolution_api import queue as queue
from tests.test_dispute_resolution_api import refunds as refunds
from tests.test_dispute_resolution_api import world as world
from tests.test_transfers import add_payment

NEEDS_ATTENTION = CUSTOMER_STATUS[JobStatus.DISPUTED]
COMPLETED = CUSTOMER_STATUS[JobStatus.CONFIRMED]
CANCELLED = CUSTOMER_STATUS[JobStatus.REFUNDED]


async def customer_views(client: httpx.AsyncClient, world: JobWorld, case: Case) -> dict[str, Any]:
    """The customer's job, their request (detail and list item) and their report."""
    headers = world.customer.headers
    job = await client.get(f"/v1/requests/{case.request_id}/job", headers=headers)
    detail = await client.get(f"/v1/requests/{case.request_id}", headers=headers)
    listed = await client.get("/v1/requests", headers=headers)
    report = await client.get(f"/v1/jobs/{case.job_id}/dispute", headers=headers)
    for response in (job, detail, listed, report):
        assert response.status_code == 200, response.text
    [item] = [i for i in listed.json()["items"] if i["id"] == str(case.request_id)]
    return {
        "job": job.json(),
        "detail": detail.json(),
        "item": item,
        "report": report.json()["dispute"],
    }


async def pro_view(client: httpx.AsyncClient, world: JobWorld, job_id: object) -> dict[str, Any]:
    one = await client.get(f"/v1/pros/me/jobs/{job_id}", headers=world.pro.headers)
    listed = await client.get(
        "/v1/pros/me/jobs", params={"active": "false"}, headers=world.pro.headers
    )
    assert (one.status_code, listed.status_code) == (200, 200), (one.text, listed.text)
    [item] = [job for job in listed.json()["items"] if job["id"] == str(job_id)]
    assert item["pro_receives_cents"] == one.json()["pro_receives_cents"]
    body: dict[str, Any] = one.json()
    return body


@pytest.mark.parametrize(
    ("decision", "release", "header", "resolution", "refund", "receives"),
    [
        (None, None, NEEDS_ATTENTION, None, None, PAYOUT),
        ("release", None, COMPLETED, "released", 0, PAYOUT),
        ("partial", ODD_RELEASE, COMPLETED, "partial_release", ODD_REFUND, ODD_RELEASE),
        ("refund", None, CANCELLED, "refunded", TOTAL, 0),
    ],
    ids=["open", "release", "partial", "refund"],
)
async def test_each_side_reads_the_outcome_of_a_reported_problem(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    refunds: FakeStripeRefunds,
    decision: str | None,
    release: int | None,
    header: str,
    resolution: str | None,
    refund: int | None,
    receives: int,
) -> None:
    """Open: needs attention, the full payout under review. Resolved with a release or a
    partial, the pro's transfer not made yet (the job is still disputed): the customer reads
    completed, and what came back; the pro, what they will receive. A full refund: cancelled
    for the customer, 0 for the pro."""
    case = await disputed(db_session, world)
    if decision is not None:
        answer = await resolve(db_client, world, case, decision, release)
        assert answer.status_code == 200, answer.text
    if decision in ("release", "partial"):
        # The transfer is still to be made: the job has not moved on.
        assert (await job_row(db_session, case.job_id)).status is JobStatus.DISPUTED

    seen = await customer_views(db_client, world, case)
    pro = await pro_view(db_client, world, case.job_id)

    assert seen["job"]["customer_status"] == header
    assert seen["detail"]["customer_status"] == seen["item"]["customer_status"] == header
    assert seen["job"]["dispute_status"] == ("open" if decision is None else "resolved")
    assert seen["job"]["dispute_resolution"] == resolution
    assert seen["report"]["customer_refund_cents"] == refund
    assert pro["pro_receives_cents"] == receives
    assert pro["pro_payout_cents"] == PAYOUT
    # Never the customer's money in the pro's view.
    assert "customer_refund_cents" not in pro
    assert "customer_total_cents" not in pro


@pytest.mark.parametrize(
    ("status", "receives"),
    [
        (JobStatus.SCHEDULED, PAYOUT),
        (JobStatus.CONFIRMED, PAYOUT),
        (JobStatus.CANCELLED, 0),
    ],
)
async def test_a_job_without_a_report_reads_as_before(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    status: JobStatus,
    receives: int,
) -> None:
    job = await make_world_job(db_session, world, status)
    await add_payment(db_session, world, job)
    await db_session.commit()

    pro = await pro_view(db_client, world, job.id)
    customer = await db_client.get(
        f"/v1/requests/{job.request_id}/job", headers=world.customer.headers
    )

    assert pro["pro_receives_cents"] == receives
    assert customer.json()["customer_status"] == CUSTOMER_STATUS[status]
    assert (customer.json()["dispute_status"], customer.json()["dispute_resolution"]) == (
        None,
        None,
    )


async def test_another_pro_never_reads_the_job(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    case = await disputed(db_session, world)

    other = await db_client.get(f"/v1/pros/me/jobs/{case.job_id}", headers=world.other_pro.headers)

    assert other.status_code == 404
