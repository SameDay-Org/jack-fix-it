"""A pro cancels their job (#69 part 2): the customer is never charged and gets their whole
payment back through #433's machinery, the request is closed by the system and never reopened,
the BDC's queue shows it under problems for OPS_PRO_CANCEL_ATTENTION_HOURS, and the customer is
told. Everything runs on the rolled-back test session, with Stripe faked; the races run on real
commits (test_cancellation_races.py)."""

import logging
import uuid
from datetime import timedelta
from typing import Any, Final

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import NotFoundError
from app.modules.audit.service import AuditService
from app.modules.cancellations.models import CancelParty, CancelReason, JobCancellation
from app.modules.cancellations.schemas import (
    CustomerCancelIn,
    CustomerCancelReason,
    ProCancelIn,
    ProCancelReason,
)
from app.modules.cancellations.service import CancelConfig, CancellationService
from app.modules.jobs.location import NoJobLocationStore
from app.modules.jobs.models import JobStatus
from app.modules.notifications import catalog
from app.modules.payments.cancel_refund_tasks import refund_cancellation
from app.modules.payments.models import RefundStatus
from app.modules.payments.transfers import ReleaseOutcome, TransferConfig, TransferService
from app.modules.requests.models import RequestStatus, ServiceRequest
from app.modules.requests.transitions import TERMINAL_STATES
from app.modules.users.service import UserService
from app.rate_limit import get_rate_limiter
from tests.conftest import make_settings
from tests.job_world import JobWorld, events, job_row
from tests.test_cancellations_api import (
    FEE,
    LIMITED,
    NOTE,
    RATE_LIMITED,
    TOTAL,
    DenyingLimiter,
    assert_no_leak,
    audit_rows,
    booked,
    cancel,
    cancellations,
    fixed_window,
    pushed,
    refund_rows,
    request_status,
    worker,
)
from tests.test_dispute_resolution_api import NOW, STUCK, FakeStripeRefunds

# The resolution tests' fixtures, used here by name.
from tests.test_dispute_resolution_api import clock as clock
from tests.test_dispute_resolution_api import queue as queue
from tests.test_dispute_resolution_api import refunds as refunds
from tests.test_dispute_resolution_api import world as world
from tests.test_disputes_api import RecordingQueue
from tests.test_transfers import FakeStripeTransfers

QUEUE: Final = "/v1/admin/requests"
# Not the default (72): the window comes from the setting.
ATTENTION_HOURS: Final = 5


def pro_cancel_path(job_id: uuid.UUID) -> str:
    return f"/v1/pros/me/jobs/{job_id}/cancel"


async def pro_cancel(
    client: httpx.AsyncClient,
    world: JobWorld,
    job_id: uuid.UUID,
    *,
    key: uuid.UUID | None = None,
    headers: dict[str, str] | None = None,
    **body: Any,
) -> httpx.Response:
    sent = {"reason_code": "cannot_make_it", **body}
    extra = {} if key is None else {"Idempotency-Key": str(key)}
    return await client.post(
        pro_cancel_path(job_id), json=sent, headers={**(headers or world.pro.headers), **extra}
    )


def without_time(body: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in body.items() if key != "cancelled_at"}


# --- The rule: never a charge to the customer ----------------------------------------------


@pytest.mark.parametrize(
    ("status", "arrived"),
    [(JobStatus.SCHEDULED, False), (JobStatus.ON_THE_WAY, False), (JobStatus.ON_THE_WAY, True)],
    ids=["scheduled", "on_the_way", "arrived"],
)
async def test_a_pro_cancel_gives_the_customer_everything_back_and_closes_the_request(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    caplog: pytest.LogCaptureFixture,
    status: JobStatus,
    arrived: bool,
) -> None:
    """Whatever the job's status, on the way and arrived included (where a customer's cancel
    pays the fee), the whole payment, tax included, is refunded: no fee. The job is cancelled
    by the pro, its request closed by the system (terminal: never reopened), with the refund's
    intent and the audit row in one transaction; the customer alone is told, after the commit;
    the worker then makes the refund in Stripe."""
    fields = {"checked_in_at": NOW, "eta_at": NOW} if arrived else {}
    job_id = await booked(db_session, world, status, **fields)

    with caplog.at_level(logging.INFO):
        answer = await pro_cancel(db_client, world, job_id, key=uuid.uuid4(), note=NOTE)

    assert answer.status_code == 200, answer.text
    assert without_time(answer.json()) == {
        "job_id": str(job_id),
        "job_status": "cancelled",
        "cancelled_by": "pro",
        "reason_code": "cannot_make_it",
    }
    # The customer's money and the note are not the pro's to read.
    assert NOTE not in answer.text
    assert (await job_row(db_session, job_id)).status is JobStatus.CANCELLED
    [moved] = [e for e in await events(db_session, job_id) if e.type == "status_changed"]
    assert (moved.from_status, moved.to_status, moved.actor_id) == (
        status,
        JobStatus.CANCELLED,
        world.pro.id,
    )
    closed = await request_status(db_session, job_id)
    assert closed is RequestStatus.CANCELLED
    assert closed in TERMINAL_STATES
    [row] = await cancellations(db_session, job_id)
    assert (row.party, row.cancelled_by, row.reason_code, row.from_status.value) == (
        CancelParty.PRO,
        world.pro.id,
        CancelReason.CANNOT_MAKE_IT,
        status.value,
    )
    assert (row.fee_bps, row.fee_cents, row.refund_cents) == (0, 0, TOTAL)
    assert row.note is not None
    assert "305-555-0199" not in row.note
    [refund] = await refund_rows(db_session, job_id)
    assert (refund.status, refund.attempts, refund.amount_cents) == (
        RefundStatus.PENDING,
        0,
        TOTAL,
    )
    assert refund.idempotency_key == f"cancel:{job_id}:refund"
    [audit] = await audit_rows(db_session, job_id)
    assert audit.actor_user_id == world.pro.id
    assert audit.before == {"status": status.value}
    assert {
        key: audit.after[key]
        for key in ("status", "cancelled_by", "reason_code", "fee_bps", "fee_cents", "refund_cents")
    } == {
        "status": "cancelled",
        "cancelled_by": "pro",
        "reason_code": "cannot_make_it",
        "fee_bps": 0,
        "fee_cents": 0,
        "refund_cents": TOTAL,
    }
    assert NOTE not in str(audit.after)
    # After the commit: the refund queued; the customer told, the pro not (they cancelled).
    assert queue.jobs[f"refund-cancellation:{job_id}"] == ("refund_cancellation", (str(job_id),))
    assert pushed(queue) == [(str(world.customer.id), f"job_cancelled_by_pro:{job_id}")]
    assert refunds.creates == []

    await refund_cancellation(worker(db_session, refunds), str(job_id))

    [create] = refunds.creates
    assert create["amount_cents"] == TOTAL
    assert create["idempotency_key"] == f"cancel:{job_id}:refund"
    [refund] = await refund_rows(db_session, job_id)
    assert (refund.status, refund.stripe_status) == (RefundStatus.CREATED, "succeeded")
    # Settled: the request stays closed.
    assert await request_status(db_session, job_id) is RequestStatus.CANCELLED
    assert_no_leak(caplog)


async def test_the_customer_s_push_says_the_pro_cancelled_and_offers_a_new_request(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
) -> None:
    """In English and Spanish: who cancelled, the whole payment going back (no timing promised),
    and a new request whenever they like. It opens the job of their request."""
    job_id = await booked(db_session, world, JobStatus.ON_THE_WAY)
    request_id = (await job_row(db_session, job_id)).request_id
    assert (await pro_cancel(db_client, world, job_id)).status_code == 200

    code = await db_session.scalar(
        select(ServiceRequest.public_code).where(ServiceRequest.id == request_id)
    )
    [push] = queue.pushes()
    assert push == (
        str(world.customer.id),
        f"job_cancelled_by_pro:{job_id}",
        "push.job_cancelled_by_pro.title",
        "push.job_cancelled_by_pro.body",
        {"public_code": code},
        f"/requests/{request_id}/job",
    )
    params = {"public_code": "JF-000124"}
    assert catalog.render("en", "push.job_cancelled_by_pro.title", params) == "Your pro cancelled"
    assert catalog.render("en", "push.job_cancelled_by_pro.body", params) == (
        "Your pro cancelled job JF-000124. Your full payment goes back to your original payment "
        "method. You can start a new request in the app anytime."
    )
    assert catalog.render("es", "push.job_cancelled_by_pro.title", params) == (
        "Tu profesional canceló"
    )
    assert catalog.render("es", "push.job_cancelled_by_pro.body", params) == (
        "Tu profesional canceló el trabajo JF-000124. El pago completo vuelve a tu método de pago "
        "original. Puedes hacer una nueva solicitud en la app cuando quieras."
    )


async def test_a_job_its_pro_cancelled_is_never_paid_out(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Any,
) -> None:
    job_id = await booked(db_session, world, JobStatus.ON_THE_WAY)
    assert (await pro_cancel(db_client, world, job_id)).status_code == 200
    stripe = FakeStripeTransfers()

    outcome = await TransferService(db_session, stripe, TransferConfig(STUCK), clock).release(
        job_id
    )

    assert outcome is ReleaseOutcome.NOT_CONFIRMED
    assert stripe.creates == []


# --- The BDC's queue: under problems for a while ---------------------------------------------


async def bucket_of(
    client: httpx.AsyncClient, session: AsyncSession, world: JobWorld, job_id: uuid.UUID
) -> str:
    """The bucket the BDC's queue puts the job's request in."""
    request_id = str((await job_row(session, job_id)).request_id)
    listed = await client.get(
        QUEUE, params={"bucket": "all", "limit": 50}, headers=world.agent.headers
    )
    assert listed.status_code == 200, listed.text
    [bucket] = [item["bucket"] for item in listed.json()["items"] if item["id"] == request_id]
    return str(bucket)


async def age_cancellation(session: AsyncSession, job_id: uuid.UUID, by: timedelta) -> None:
    await session.execute(
        update(JobCancellation)
        .where(JobCancellation.job_id == job_id)
        .values(created_at=func.now() - by)
    )
    await session.commit()


@pytest.mark.parametrize(
    "settings", [make_settings(ops_pro_cancel_attention_hours=ATTENTION_HOURS)]
)
async def test_a_pro_cancelled_request_is_a_problem_for_the_setting_s_hours_then_other(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    settings: Settings,
) -> None:
    """The BDC sees the request under problems once its pro cancelled, for
    OPS_PRO_CANCEL_ATTENTION_HOURS by the database clock, then under other with every closed
    request. A customer's own cancel is no problem."""
    by_pro = await booked(db_session, world, JobStatus.ON_THE_WAY)
    by_customer = await booked(db_session, world, JobStatus.ON_THE_WAY)
    assert (await pro_cancel(db_client, world, by_pro)).status_code == 200
    assert (await cancel(db_client, world, by_customer)).status_code == 200

    assert await bucket_of(db_client, db_session, world, by_pro) == "problems"
    assert await bucket_of(db_client, db_session, world, by_customer) == "other"
    problems = await db_client.get(
        QUEUE, params={"bucket": "problems"}, headers=world.agent.headers
    )
    request_id = str((await job_row(db_session, by_pro)).request_id)
    assert [item["id"] for item in problems.json()["items"]] == [request_id]

    await age_cancellation(db_session, by_pro, timedelta(hours=ATTENTION_HOURS, minutes=-1))
    assert await bucket_of(db_client, db_session, world, by_pro) == "problems"
    await age_cancellation(db_session, by_pro, timedelta(hours=ATTENTION_HOURS, minutes=1))
    assert await bucket_of(db_client, db_session, world, by_pro) == "other"


def test_the_attention_window_defaults_to_three_days() -> None:
    assert Settings.model_fields["ops_pro_cancel_attention_hours"].default == 72


# --- Refused ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "status",
    [
        JobStatus.IN_PROGRESS,
        JobStatus.COMPLETED,
        JobStatus.CONFIRMED,
        JobStatus.PAID_OUT,
        JobStatus.DISPUTED,
        JobStatus.REFUNDED,
    ],
)
async def test_a_job_whose_work_started_or_ended_cannot_be_cancelled_by_its_pro(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    status: JobStatus,
) -> None:
    job_id = await booked(db_session, world, status)

    answer = await pro_cancel(db_client, world, job_id)

    assert answer.status_code == 409
    assert answer.json()["error"]["code"] == "cancel_not_allowed"
    assert f"it is {status.value}" in answer.json()["error"]["message"]
    assert (await job_row(db_session, job_id)).status is status
    assert await request_status(db_session, job_id) is RequestStatus.ACCEPTED
    assert (await cancellations(db_session, job_id), await refund_rows(db_session, job_id)) == (
        [],
        [],
    )
    assert queue.jobs == {}


async def test_only_the_job_s_own_pro_cancels_it_here(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
) -> None:
    """Another pro's job and an unknown one are the same 404; anyone but a pro is refused
    (403), the job's own customer included: their cancel is the other route."""
    job_id = await booked(db_session, world)

    cases = [
        (job_id, world.other_pro.headers, 404),
        (uuid.uuid4(), world.pro.headers, 404),
        (job_id, world.customer.headers, 403),
        (job_id, world.other_customer.headers, 403),
        (job_id, world.agent.headers, 403),
        (job_id, world.admin.headers, 403),
    ]
    for target, headers, expected in cases:
        answer = await pro_cancel(db_client, world, target, headers=headers)
        assert answer.status_code == expected, (headers, answer.text)
    assert (await job_row(db_session, job_id)).status is JobStatus.SCHEDULED
    assert await cancellations(db_session, job_id) == []


async def test_the_service_cancels_only_from_the_caller_s_own_side(
    db_session: AsyncSession, world: JobWorld
) -> None:
    """Below the routes' role checks: the job's customer through the pro's entry point, or its
    pro through the customer's, has no job of theirs on that side (404). Nothing is written."""
    job_id = await booked(db_session, world)
    users = UserService(db_session)
    customer = await users.get_by_id(world.customer.id)
    pro = await users.get_by_id(world.pro.id)
    assert customer is not None
    assert pro is not None
    service = CancellationService(db_session, CancelConfig(1500, 1.0), NoJobLocationStore())

    with pytest.raises(NotFoundError):
        await service.cancel_as_pro(
            customer,
            job_id,
            ProCancelIn(reason_code=ProCancelReason.CANNOT_MAKE_IT),
            RecordingQueue(),
        )
    with pytest.raises(NotFoundError):
        await service.cancel_as_customer(
            pro,
            job_id,
            CustomerCancelIn(reason_code=CustomerCancelReason.CHANGED_MY_MIND),
            RecordingQueue(),
        )

    assert (await job_row(db_session, job_id)).status is JobStatus.SCHEDULED
    assert await cancellations(db_session, job_id) == []


@pytest.mark.parametrize(
    "body",
    [
        {"reason_code": "changed_my_mind"},  # a customer's reason
        {"reason_code": "bored"},
        {"reason_code": "other", "note": "​​"},
        {"reason_code": "other", "note": "x" * 501},
        {"reason_code": "other", "expected_fee_cents": 0},  # the customer's check, not the pro's
        {"reason_code": "other", "refund_cents": 1},  # amounts are never taken from a client
        {},
    ],
)
async def test_a_body_the_pro_route_cannot_trust_is_refused(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    body: dict[str, Any],
) -> None:
    job_id = await booked(db_session, world)

    answer = await db_client.post(pro_cancel_path(job_id), json=body, headers=world.pro.headers)

    assert answer.status_code == 422
    assert answer.json()["error"]["code"] == "validation_error"
    assert (await job_row(db_session, job_id)).status is JobStatus.SCHEDULED


async def test_the_customer_route_takes_no_pro_reason(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job_id = await booked(db_session, world)

    answer = await cancel(db_client, world, job_id, reason_code="customer_unreachable")

    assert answer.status_code == 422


# --- Once, and only as sent -------------------------------------------------------------------


async def test_a_second_pro_cancel_returns_the_first_with_one_refund_and_one_push(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
) -> None:
    """A retry with the same Idempotency-Key and body, or one without a key: the first
    cancellation (200), nothing written again, no second push. The refund, not settled yet, is
    queued again; the worker still makes one Stripe refund."""
    job_id = await booked(db_session, world, JobStatus.ON_THE_WAY)
    key = uuid.uuid4()
    first = await pro_cancel(db_client, world, job_id, key=key, note=NOTE)

    retry = await pro_cancel(db_client, world, job_id, key=key, note=NOTE)
    plain = await pro_cancel(db_client, world, job_id, reason_code="other")

    assert first.status_code == retry.status_code == plain.status_code == 200
    assert first.json() == retry.json() == plain.json()
    assert len(await cancellations(db_session, job_id)) == 1
    assert len(await refund_rows(db_session, job_id)) == 1
    assert len(await audit_rows(db_session, job_id)) == 1
    assert len(pushed(queue)) == 1
    assert queue.order.count("enqueue:refund_cancellation") == 3
    await refund_cancellation(worker(db_session, refunds), str(job_id))
    await refund_cancellation(worker(db_session, refunds), str(job_id))
    assert len(refunds.creates) == 1


async def test_each_side_s_cancel_after_the_other_s_returns_it(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
) -> None:
    """A job is cancelled once. The pro cancelling a job its customer cancelled reads that
    cancellation (the customer's, with the fee they paid), and the customer cancelling a job
    its pro cancelled reads the pro's (no fee, everything back). Nothing is written again."""
    by_customer = await booked(db_session, world, JobStatus.ON_THE_WAY)
    by_pro = await booked(db_session, world, JobStatus.ON_THE_WAY)
    assert (await cancel(db_client, world, by_customer)).status_code == 200
    assert (await pro_cancel(db_client, world, by_pro)).status_code == 200
    before = len(queue.pushes())

    pro_after = await pro_cancel(db_client, world, by_customer)
    customer_after = await cancel(db_client, world, by_pro, expected_fee_cents=FEE)

    assert pro_after.status_code == 200, pro_after.text
    assert without_time(pro_after.json()) == {
        "job_id": str(by_customer),
        "job_status": "cancelled",
        "cancelled_by": "customer",
        "reason_code": "changed_my_mind",
    }
    # The fee the customer was shown is not checked on a cancellation that already stands.
    assert customer_after.status_code == 200, customer_after.text
    seen = customer_after.json()
    assert (seen["cancelled_by"], seen["fee_cents"], seen["refund_cents"]) == ("pro", 0, TOTAL)
    for job_id in (by_customer, by_pro):
        assert len(await cancellations(db_session, job_id)) == 1
        assert len(await audit_rows(db_session, job_id)) == 1
    assert len(queue.pushes()) == before


async def test_a_pro_s_idempotency_key_is_never_used_with_another_body_or_job(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
) -> None:
    job_id = await booked(db_session, world)
    other = await booked(db_session, world)
    key = uuid.uuid4()
    assert (await pro_cancel(db_client, world, job_id, key=key)).status_code == 200

    another_body = await pro_cancel(db_client, world, job_id, key=key, reason_code="other")
    another_job = await pro_cancel(db_client, world, other, key=key)

    for answer in (another_body, another_job):
        assert answer.status_code == 409
        assert answer.json()["error"]["code"] == "idempotency_key_reused"
    assert (await job_row(db_session, other)).status is JobStatus.SCHEDULED
    assert await cancellations(db_session, other) == []


async def test_a_failure_before_the_commit_leaves_the_pro_s_job_as_it_was(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One transaction: the audit write fails last, and nothing of the cancel stays (no row,
    no refund intent, the job and its request unchanged), nothing is queued or sent."""

    async def broken(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("audit down")

    monkeypatch.setattr(AuditService, "record_party_action", broken)
    job_id = await booked(db_session, world, JobStatus.ON_THE_WAY)

    answer = await pro_cancel(db_client, world, job_id)

    assert answer.status_code == 500
    assert (await job_row(db_session, job_id)).status is JobStatus.ON_THE_WAY
    assert await request_status(db_session, job_id) is RequestStatus.ACCEPTED
    assert (await cancellations(db_session, job_id), await refund_rows(db_session, job_id)) == (
        [],
        [],
    )
    assert queue.jobs == {}
    assert refunds.creates == []


# --- Both sides read it with the job ----------------------------------------------------------


async def test_both_sides_read_the_pro_s_cancellation_with_the_job(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
) -> None:
    """The customer's job view: the pro cancelled, nothing kept, everything back. The pro's job
    view: the same cancellation as the cancel answered, never the money or the note."""
    job_id = await booked(db_session, world, JobStatus.ON_THE_WAY)
    request_id = (await job_row(db_session, job_id)).request_id
    answer = await pro_cancel(db_client, world, job_id, note=NOTE)
    assert answer.status_code == 200, answer.text

    customer = await db_client.get(f"/v1/requests/{request_id}/job", headers=world.customer.headers)
    one = await db_client.get(f"/v1/pros/me/jobs/{job_id}", headers=world.pro.headers)

    seen = customer.json()["cancellation"]
    assert without_time(seen) == {
        "cancelled_by": "pro",
        "reason_code": "cannot_make_it",
        "customer_total_cents": TOTAL,
        "fee_cents": 0,
        "refund_cents": TOTAL,
        "refund_status": "pending",
    }
    pro_view = one.json()["cancellation"]
    assert pro_view == {
        key: answer.json()[key] for key in ("cancelled_by", "reason_code", "cancelled_at")
    }
    assert NOTE not in one.text


# --- Rate limits -----------------------------------------------------------------------------


@pytest.mark.parametrize("settings", [LIMITED])
async def test_pro_cancels_are_limited_per_pro_and_a_replay_counts(
    app: FastAPI, db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    fixed_window(app)
    job_id = await booked(db_session, world)
    key = uuid.uuid4()

    first = await pro_cancel(db_client, world, job_id, key=key)
    replay = await pro_cancel(db_client, world, job_id, key=key)
    third = await pro_cancel(db_client, world, job_id, key=key)
    other = await pro_cancel(db_client, world, job_id, headers=world.other_pro.headers)

    assert [first.status_code, replay.status_code, third.status_code] == [200, 200, 429]
    assert third.json() == RATE_LIMITED
    assert third.headers["cache-control"] == "no-store"
    assert int(third.headers["retry-after"]) > 0
    # Another pro has their own count (the job is not theirs: 404, never 429).
    assert other.status_code == 404
    assert len(await cancellations(db_session, job_id)) == 1


async def test_a_refused_hit_stops_the_pro_s_cancel_before_anything_is_read_or_written(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    settings: Settings,
) -> None:
    limiter = DenyingLimiter()
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    job_id = await booked(db_session, world)

    cancelled = await pro_cancel(db_client, world, job_id)
    # Not a pro: refused before the limit is asked.
    customer = await pro_cancel(db_client, world, job_id, headers=world.customer.headers)

    assert (cancelled.status_code, cancelled.json()) == (429, RATE_LIMITED)
    assert cancelled.headers["retry-after"] == "7"
    assert customer.status_code == 403
    assert limiter.hits == [
        (
            "cancel_write",
            str(world.pro.id),
            settings.cancel_write_limit,
            settings.cancel_write_window_seconds,
        )
    ]
    assert await cancellations(db_session, job_id) == []
    assert (await job_row(db_session, job_id)).status is JobStatus.SCHEDULED
