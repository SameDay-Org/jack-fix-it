"""A customer cancels their job (#69): the fee rule, the refund through #433's machinery, the
worker's steps and Stripe's events, with Stripe faked. Everything runs on the rolled-back test
session; the race of two cancels runs on real commits (test_cancellation_races.py)."""

import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Final

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_app_settings
from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.modules.audit.models import AuditLog
from app.modules.audit.service import AuditService
from app.modules.cancellations.models import JobCancellation
from app.modules.jobs.models import JobStatus
from app.modules.payments.cancel_refund_tasks import refund_cancellation, retry_cancel_refunds
from app.modules.payments.cancel_refunds import CancelRefundOutcome, CancelRefunds
from app.modules.payments.models import Refund, RefundStatus
from app.modules.payments.transfers import ReleaseOutcome, TransferConfig, TransferService
from app.modules.requests.models import RequestStatus, ServiceRequest
from tests.conftest import make_settings
from tests.job_world import PRICE, TAX, JobWorld, events, job_row
from tests.job_world import make_job as make_world_job
from tests.test_dispute_resolution_api import (
    NOW,
    STUCK,
    FakeStripeRefunds,
    SimulatedCrash,
    deliver,
    refund_event,
)

# The resolution tests' fixtures, used here by name.
from tests.test_dispute_resolution_api import clock as clock
from tests.test_dispute_resolution_api import queue as queue
from tests.test_dispute_resolution_api import refunds as refunds
from tests.test_dispute_resolution_api import world as world
from tests.test_disputes_api import RecordingQueue
from tests.test_transfers import FakeStripeTransfers, add_payment

TOTAL: Final = PRICE + TAX
# 15% of the job price (20,000), before tax: 3,000; the rest of the 21,400 paid is refunded.
FEE: Final = 3_000
NOTE: Final = "zq69 call me at 305-555-0199 about it"
LEAKS: Final = ("re_probe76", "pi_probe68", "305-555-0199", "zq69")


@asynccontextmanager
async def _same(session: AsyncSession) -> AsyncIterator[AsyncSession]:
    yield session


def worker(session: AsyncSession, stripe: FakeStripeRefunds | None) -> dict[str, Any]:
    """The worker's context, on the test session, with Stripe faked."""
    return {
        "session_factory": lambda: _same(session),
        "settings": make_settings(refund_stuck_pending_minutes=int(STUCK.total_seconds() // 60)),
        "stripe_refunds": stripe,
    }


async def booked(
    session: AsyncSession, world: JobWorld, status: JobStatus = JobStatus.SCHEDULED, **fields: Any
) -> uuid.UUID:
    """A paid job in `status`, its request accepted, committed."""
    job = await make_world_job(session, world, status, **fields)
    await add_payment(session, world, job)
    await session.commit()
    return job.id


def cancel_path(job_id: uuid.UUID) -> str:
    return f"/v1/jobs/{job_id}/cancel"


async def cancel(
    client: httpx.AsyncClient,
    world: JobWorld,
    job_id: uuid.UUID,
    *,
    key: uuid.UUID | None = None,
    headers: dict[str, str] | None = None,
    **body: Any,
) -> httpx.Response:
    sent = {"reason_code": "changed_my_mind", **body}
    extra = {} if key is None else {"Idempotency-Key": str(key)}
    return await client.post(
        cancel_path(job_id), json=sent, headers={**(headers or world.customer.headers), **extra}
    )


async def preview(
    client: httpx.AsyncClient,
    world: JobWorld,
    job_id: uuid.UUID,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    return await client.get(
        f"/v1/jobs/{job_id}/cancel-preview", headers=headers or world.customer.headers
    )


async def refund_rows(session: AsyncSession, job_id: uuid.UUID) -> list[Refund]:
    statement = (
        select(Refund).where(Refund.job_id == job_id).execution_options(populate_existing=True)
    )
    return list((await session.scalars(statement)).all())


async def cancellations(session: AsyncSession, job_id: uuid.UUID) -> list[JobCancellation]:
    statement = select(JobCancellation).where(JobCancellation.job_id == job_id)
    return list((await session.scalars(statement)).all())


async def audit_rows(session: AsyncSession, job_id: uuid.UUID) -> list[AuditLog]:
    statement = select(AuditLog).where(
        AuditLog.action == "job.cancel", AuditLog.entity_id == job_id
    )
    return list((await session.scalars(statement)).all())


async def request_status(session: AsyncSession, job_id: uuid.UUID) -> RequestStatus:
    job = await job_row(session, job_id)
    statement = (
        select(ServiceRequest.status)
        .where(ServiceRequest.id == job.request_id)
        .execution_options(populate_existing=True)
    )
    status = await session.scalar(statement)
    assert status is not None
    return status


def pushed(queue: RecordingQueue) -> list[tuple[object, object]]:
    return [(push[0], push[1]) for push in queue.pushes()]


def assert_no_leak(caplog: pytest.LogCaptureFixture) -> None:
    rendered = caplog.text + "".join(str(record.__dict__) for record in caplog.records)
    for leak in LEAKS:
        assert leak not in rendered, leak


# --- The rule: free before On my way, the fee after it -----------------------------------------


@pytest.mark.parametrize(
    ("status", "arrived", "fee"),
    [
        (JobStatus.SCHEDULED, False, 0),
        (JobStatus.ON_THE_WAY, False, FEE),
        (JobStatus.ON_THE_WAY, True, FEE),
    ],
)
async def test_a_customer_cancel_refunds_the_payment_minus_the_fee_once_the_pro_set_off(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    caplog: pytest.LogCaptureFixture,
    status: JobStatus,
    arrived: bool,
    fee: int,
) -> None:
    """Before On my way the whole payment (tax included) comes back; after it (on the way or
    arrived) 15% of the job price is kept and the rest comes back. The job and its request are
    cancelled in one transaction with the refund's intent and the audit row; the worker then
    makes the refund in Stripe, settled at succeeded."""
    fields = {"checked_in_at": NOW, "eta_at": NOW} if arrived else {}
    job_id = await booked(db_session, world, status, **fields)
    shown = await preview(db_client, world, job_id)
    assert shown.status_code == 200, shown.text
    assert shown.json() == {
        "job_id": str(job_id),
        "job_status": status.value,
        "fee_applies": fee > 0,
        "customer_total_cents": TOTAL,
        "fee_cents": fee,
        "refund_cents": TOTAL - fee,
        "currency": "usd",
    }

    with caplog.at_level(logging.INFO):
        answer = await cancel(db_client, world, job_id, note=NOTE, expected_fee_cents=fee)

    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert {k: body[k] for k in body if k != "cancelled_at"} == {
        "job_id": str(job_id),
        "job_status": "cancelled",
        "cancelled_by": "customer",
        "reason_code": "changed_my_mind",
        "fee_cents": fee,
        "refund_cents": TOTAL - fee,
        "currency": "usd",
        "refund_status": "pending",
    }
    assert fee + body["refund_cents"] == TOTAL
    assert (await job_row(db_session, job_id)).status is JobStatus.CANCELLED
    [moved] = [e for e in await events(db_session, job_id) if e.type == "status_changed"]
    assert (moved.from_status, moved.to_status, moved.actor_id) == (
        status,
        JobStatus.CANCELLED,
        world.customer.id,
    )
    assert await request_status(db_session, job_id) is RequestStatus.CANCELLED
    [row] = await cancellations(db_session, job_id)
    assert (row.fee_bps, row.fee_cents, row.refund_cents, row.from_status.value) == (
        1500 if fee else 0,
        fee,
        TOTAL - fee,
        status.value,
    )
    # The note is kept masked.
    assert row.note is not None
    assert "305-555-0199" not in row.note
    [refund] = await refund_rows(db_session, job_id)
    assert (refund.status, refund.attempts, refund.amount_cents, refund.dispute_id) == (
        RefundStatus.PENDING,
        0,
        TOTAL - fee,
        None,
    )
    assert refund.idempotency_key == f"cancel:{job_id}:refund"
    [audit] = await audit_rows(db_session, job_id)
    assert audit.actor_user_id == world.customer.id
    assert audit.before == {"status": status.value}
    assert {k: audit.after[k] for k in ("status", "fee_cents", "refund_cents", "reason_code")} == {
        "status": "cancelled",
        "fee_cents": fee,
        "refund_cents": TOTAL - fee,
        "reason_code": "changed_my_mind",
    }
    # After the commit: the refund queued, and both sides told.
    assert queue.jobs[f"refund-cancellation:{job_id}"] == ("refund_cancellation", (str(job_id),))
    assert sorted(pushed(queue), key=str) == sorted(
        [
            (str(world.pro.id), f"job_cancelled_by_customer:{job_id}"),
            (str(world.customer.id), f"job_cancelled:{job_id}"),
        ],
        key=str,
    )
    assert refunds.creates == []  # nothing reached Stripe in the request

    await refund_cancellation(worker(db_session, refunds), str(job_id))

    [create] = refunds.creates
    assert create["amount_cents"] == TOTAL - fee
    assert create["idempotency_key"] == f"cancel:{job_id}:refund"
    assert create["metadata"] == {"job_id": str(job_id), "refund_key": f"cancel:{job_id}:refund"}
    [refund] = await refund_rows(db_session, job_id)
    assert (refund.status, refund.stripe_status) == (RefundStatus.CREATED, "succeeded")
    again = await cancel(db_client, world, job_id)
    assert again.json()["refund_status"] == "succeeded"
    assert_no_leak(caplog)


async def test_the_fee_comes_from_the_setting(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
) -> None:
    app.dependency_overrides[get_app_settings] = lambda: make_settings(cancellation_fee_bps=1_001)
    job_id = await booked(db_session, world, JobStatus.ON_THE_WAY)

    answer = await cancel(db_client, world, job_id)

    # 20,000 x 10.01% = 2,002.
    assert (answer.json()["fee_cents"], answer.json()["refund_cents"]) == (2_002, TOTAL - 2_002)
    [row] = await cancellations(db_session, job_id)
    assert row.fee_bps == 1_001


async def test_a_fee_other_than_the_one_shown_cancels_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
) -> None:
    """The preview showed the free cancel; the pro tapped On my way before the customer
    confirmed: the fee is not taken behind their back."""
    job_id = await booked(db_session, world, JobStatus.ON_THE_WAY)

    answer = await cancel(db_client, world, job_id, expected_fee_cents=0)

    assert answer.status_code == 409
    assert answer.json()["error"]["code"] == "cancel_fee_changed"
    assert (await job_row(db_session, job_id)).status is JobStatus.ON_THE_WAY
    assert (await cancellations(db_session, job_id), await refund_rows(db_session, job_id)) == (
        [],
        [],
    )
    assert queue.jobs == {}


# --- Refused --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "status",
    [
        JobStatus.IN_PROGRESS,
        JobStatus.COMPLETED,
        JobStatus.CONFIRMED,
        JobStatus.PAID_OUT,
        JobStatus.DISPUTED,
        JobStatus.REFUNDED,
        JobStatus.CANCELLED,
    ],
)
async def test_a_job_whose_work_started_or_ended_cannot_be_cancelled(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    status: JobStatus,
) -> None:
    job_id = await booked(db_session, world, status)

    answer = await cancel(db_client, world, job_id)
    shown = await preview(db_client, world, job_id)

    for response in (answer, shown):
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "cancel_not_allowed"
        assert f"it is {status.value}" in response.json()["error"]["message"]
    assert (await job_row(db_session, job_id)).status is status
    assert (await cancellations(db_session, job_id), await refund_rows(db_session, job_id)) == (
        [],
        [],
    )
    assert queue.jobs == {}


async def test_only_the_job_s_own_customer_cancels_or_previews(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
) -> None:
    job_id = await booked(db_session, world)

    cases = [
        (job_id, world.other_customer.headers, 404),
        (uuid.uuid4(), world.customer.headers, 404),
        (job_id, world.pro.headers, 403),
        (job_id, world.other_pro.headers, 403),
        (job_id, world.agent.headers, 403),
        (job_id, world.admin.headers, 403),
    ]
    for target, headers, expected in cases:
        assert (await cancel(db_client, world, target, headers=headers)).status_code == expected
        assert (await preview(db_client, world, target, headers)).status_code == expected
    assert (await job_row(db_session, job_id)).status is JobStatus.SCHEDULED
    assert await cancellations(db_session, job_id) == []


# --- Once, and only as sent -------------------------------------------------------------------


async def test_a_second_cancel_returns_the_first_with_one_refund_and_one_push(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
) -> None:
    """A retry with the same Idempotency-Key and body, or a cancel without a key: the first
    cancellation as it is now (200), nothing written again, no second push. The refund, not
    settled yet, is queued again; the worker still makes one Stripe refund."""
    job_id = await booked(db_session, world, JobStatus.ON_THE_WAY)
    key = uuid.uuid4()
    first = await cancel(db_client, world, job_id, key=key, note=NOTE)

    retry = await cancel(db_client, world, job_id, key=key, note=NOTE)
    plain = await cancel(db_client, world, job_id, reason_code="other")

    assert first.status_code == retry.status_code == plain.status_code == 200
    assert first.json() == retry.json() == plain.json()
    assert len(await cancellations(db_session, job_id)) == 1
    assert len(await refund_rows(db_session, job_id)) == 1
    assert len(await audit_rows(db_session, job_id)) == 1
    assert len(pushed(queue)) == 2
    assert queue.order.count("enqueue:refund_cancellation") == 3
    await refund_cancellation(worker(db_session, refunds), str(job_id))
    await refund_cancellation(worker(db_session, refunds), str(job_id))
    assert len(refunds.creates) == 1


async def test_an_idempotency_key_is_never_used_with_another_body_or_job(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
) -> None:
    job_id = await booked(db_session, world)
    other = await booked(db_session, world)
    key = uuid.uuid4()
    assert (await cancel(db_client, world, job_id, key=key)).status_code == 200

    another_body = await cancel(db_client, world, job_id, key=key, reason_code="other")
    another_job = await cancel(db_client, world, other, key=key)

    for answer in (another_body, another_job):
        assert answer.status_code == 409
        assert answer.json()["error"]["code"] == "idempotency_key_reused"
    assert (await job_row(db_session, other)).status is JobStatus.SCHEDULED
    assert await cancellations(db_session, other) == []


@pytest.mark.parametrize(
    "body",
    [
        {"reason_code": "cannot_make_it"},  # a pro's reason
        {"reason_code": "bored"},
        {"reason_code": "other", "note": "\u200b\u200b"},
        {"reason_code": "other", "note": "x" * 501},
        {"reason_code": "other", "expected_fee_cents": -1},
        {"reason_code": "other", "refund_cents": 1},  # amounts are never taken from a client
    ],
)
async def test_a_body_the_server_cannot_trust_is_refused(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    body: dict[str, Any],
) -> None:
    job_id = await booked(db_session, world)

    answer = await db_client.post(cancel_path(job_id), json=body, headers=world.customer.headers)

    assert answer.status_code == 422
    assert answer.json()["error"]["code"] == "validation_error"
    assert (await job_row(db_session, job_id)).status is JobStatus.SCHEDULED


async def test_a_failure_before_the_commit_leaves_the_job_as_it_was(
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

    answer = await cancel(db_client, world, job_id)

    assert answer.status_code == 500
    assert (await job_row(db_session, job_id)).status is JobStatus.ON_THE_WAY
    assert await request_status(db_session, job_id) is RequestStatus.ACCEPTED
    assert (await cancellations(db_session, job_id), await refund_rows(db_session, job_id)) == (
        [],
        [],
    )
    assert queue.jobs == {}
    assert refunds.creates == []


async def test_a_cancelled_job_is_never_paid_out(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Any,
) -> None:
    job_id = await booked(db_session, world, JobStatus.ON_THE_WAY)
    assert (await cancel(db_client, world, job_id)).status_code == 200
    stripe = FakeStripeTransfers()

    outcome = await TransferService(db_session, stripe, TransferConfig(STUCK), clock).release(
        job_id
    )

    assert outcome is ReleaseOutcome.NOT_CONFIRMED
    assert stripe.creates == []


# --- The refund: made by the worker, settled at succeeded ---------------------------------


async def age_attempts(session: AsyncSession, job_id: uuid.UUID) -> None:
    """The refund's latest try, and its creation, older than the stuck window."""
    past = func.now() - text(f"interval '{int(STUCK.total_seconds()) + 60} seconds'")
    await session.execute(
        update(Refund).where(Refund.job_id == job_id).values(requested_at=past, created_at=past)
    )
    await session.commit()


async def test_a_lost_stripe_answer_is_adopted_by_the_sweep_without_a_second_refund(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    refunds: FakeStripeRefunds,
) -> None:
    job_id = await booked(db_session, world)
    assert (await cancel(db_client, world, job_id)).status_code == 200
    refunds.lost_answers = 1

    await refund_cancellation(worker(db_session, refunds), str(job_id))
    [row] = await refund_rows(db_session, job_id)
    assert (row.status, row.attempts, row.last_error_definitive) == (RefundStatus.FAILED, 1, False)
    # Not due yet: the sweep waits out the stuck window.
    await retry_cancel_refunds(worker(db_session, refunds))
    assert refunds.lists == []
    await age_attempts(db_session, job_id)
    await retry_cancel_refunds(worker(db_session, refunds))

    assert len(refunds.creates) == 1
    assert len(refunds.lists) == 1
    [row] = await refund_rows(db_session, job_id)
    assert (row.status, row.attempts, row.stripe_status) == (RefundStatus.CREATED, 2, "succeeded")


async def test_a_refund_stripe_refuses_for_good_is_flagged_for_staff_and_never_retried(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    refunds: FakeStripeRefunds,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Stripe's definitive answer to the create: the same key would get it again. The job stays
    cancelled, its refund failed for the customer to see and for staff (an ERROR with ids)."""
    job_id = await booked(db_session, world)
    assert (await cancel(db_client, world, job_id)).status_code == 200
    refunds.errors["create"] = [StripeRejectedError(code="charge_disputed")]

    with caplog.at_level(logging.INFO):
        await refund_cancellation(worker(db_session, refunds), str(job_id))
    await age_attempts(db_session, job_id)
    await retry_cancel_refunds(worker(db_session, refunds))

    [row] = await refund_rows(db_session, job_id)
    assert (row.status, row.last_error_code, row.last_error_definitive, row.attempts) == (
        RefundStatus.FAILED,
        "charge_disputed",
        True,
        1,
    )
    # The sweep never tried again: a retry would have gone through the fake this time.
    assert refunds.creates == []
    [error] = [r for r in caplog.records if r.getMessage() == "cancel_refund_failed"]
    assert (error.levelno, error.__dict__["job_id"]) == (logging.ERROR, str(job_id))
    assert (await cancel(db_client, world, job_id)).json()["refund_status"] == "failed"
    assert (await job_row(db_session, job_id)).status is JobStatus.CANCELLED
    assert_no_leak(caplog)


async def test_stripe_unavailable_is_retried_by_the_sweep(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    refunds: FakeStripeRefunds,
) -> None:
    job_id = await booked(db_session, world)
    assert (await cancel(db_client, world, job_id)).status_code == 200
    refunds.errors["create"] = [StripeUnavailableError(request_id="req_down")]

    await refund_cancellation(worker(db_session, refunds), str(job_id))
    assert (await cancel(db_client, world, job_id)).json()["refund_status"] == "pending"
    await age_attempts(db_session, job_id)
    await retry_cancel_refunds(worker(db_session, refunds))

    [row] = await refund_rows(db_session, job_id)
    assert (row.status, row.stripe_status) == (RefundStatus.CREATED, "succeeded")


async def test_the_attempt_is_committed_before_stripe_is_called(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    refunds: FakeStripeRefunds,
) -> None:
    """The worker dies right after Stripe made the refund: the stamped attempt outlives it, so
    the next run looks the refund up instead of trusting nothing happened."""
    job_id = await booked(db_session, world)
    assert (await cancel(db_client, world, job_id)).status_code == 200
    refunds.crashes = 1
    service = CancelRefunds(db_session, refunds, STUCK)

    with pytest.raises(SimulatedCrash):
        await service.make(job_id)

    [row] = await refund_rows(db_session, job_id)
    assert (row.status, row.attempts, row.requested_at is not None) == (
        RefundStatus.PENDING,
        1,
        True,
    )
    # Under way: the next run leaves it alone until the window passes, then adopts it.
    assert await service.make(job_id) is CancelRefundOutcome.IN_FLIGHT
    await age_attempts(db_session, job_id)
    assert await service.make(job_id) is CancelRefundOutcome.STORED
    assert len(refunds.creates) == 1


@pytest.mark.parametrize("ends", ["succeeded", "failed"])
async def test_a_pending_refund_settles_only_when_stripe_s_event_says_so(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    caplog: pytest.LogCaptureFixture,
    ends: str,
) -> None:
    job_id = await booked(db_session, world)
    assert (await cancel(db_client, world, job_id)).status_code == 200
    refunds.status = "pending"
    await refund_cancellation(worker(db_session, refunds), str(job_id))
    assert (await cancel(db_client, world, job_id)).json()["refund_status"] == "pending"
    [made] = refunds.refunds.values()
    refunds.set_status(made.refund_id, ends)

    with caplog.at_level(logging.INFO):
        # The event's own status is never trusted: Stripe is read again.
        await deliver(
            db_session, refunds, queue, refund_event("refund.updated", made.refund_id, "x")
        )

    [row] = await refund_rows(db_session, job_id)
    assert row.stripe_status == ends
    assert (await cancel(db_client, world, job_id)).json()["refund_status"] == ends
    messages = [r.getMessage() for r in caplog.records]
    assert "refund_event_unknown_refund" not in messages
    if ends == "failed":
        [error] = [r for r in caplog.records if r.getMessage() == "cancel_refund_failed"]
        assert error.levelno == logging.ERROR
