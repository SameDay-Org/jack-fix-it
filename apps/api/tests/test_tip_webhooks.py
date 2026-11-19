"""payment_intent.* events of a tip's PaymentIntent (#273, PR A1): routed by metadata kind to
the tips module, through the registry the worker reads (webhooks/handlers.py), on the
rolled-back test session (a handler never commits)."""

import logging
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.payments.webhook_handlers import PAYMENT_INTENT_HANDLERS
from app.modules.tips.errors import TipEventMismatchError
from app.modules.tips.models import Tip, TipChoice, TipStatus
from app.modules.users.models import User
from app.modules.webhooks.events import AfterCommit, StripeEvent
from app.modules.webhooks.handlers import handler_for
from tests.job_world import JobWorld, build_world, make_job

STRIPE_CUSTOMER = "cus_tipwebhook273"
INTENT = "pi_tipwebhook273"
AMOUNT = 2_400
SUCCEEDED = "payment_intent.succeeded"
PROCESSING = "payment_intent.processing"
FAILED = "payment_intent.payment_failed"
CANCELED = "payment_intent.canceled"
CURRENT = object()  # metadata: the tip's own, as its create writes it


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    world = await build_world(db_session)
    await db_session.execute(
        update(User).where(User.id == world.customer.id).values(stripe_customer_id=STRIPE_CUSTOMER)
    )
    return world


@pytest.fixture
async def job(db_session: AsyncSession, world: JobWorld) -> Job:
    at = datetime.now(UTC) - timedelta(hours=1)
    return await make_job(
        db_session,
        world,
        JobStatus.CONFIRMED,
        completed_at=at - timedelta(hours=1),
        confirmed_at=at,
    )


async def add_tip(
    session: AsyncSession,
    world: JobWorld,
    job: Job,
    *,
    intent: str | None = INTENT,
    attempt: int = 1,
    status: TipStatus = TipStatus.REQUIRES_PAYMENT,
) -> Tip:
    tip = Tip(
        job_id=job.id,
        request_id=job.request_id,
        customer_id=world.customer.id,
        pro_id=world.pro.profile_id,
        choice=TipChoice.PERCENT,
        percent=12,
        amount_cents=AMOUNT,
        currency="usd",
        status=status,
        stripe_payment_intent_id=intent,
        attempt=attempt,
        payment_intent_requested_at=datetime.now(UTC) - timedelta(minutes=5),
    )
    session.add(tip)
    await session.flush()
    return tip


def event(
    event_type: str,
    tip: Tip | None,
    *,
    intent: str = INTENT,
    amount: int = AMOUNT,
    currency: str = "usd",
    customer: str | None = STRIPE_CUSTOMER,
    metadata: object = CURRENT,
    failure_code: str | None = None,
) -> StripeEvent:
    if metadata is CURRENT:
        assert tip is not None
        metadata = {
            "kind": "tip",
            "tip_id": str(tip.id),
            "job_id": str(tip.job_id),
            "attempt": str(tip.attempt),
        }
    event_id = f"evt_tip{uuid.uuid4().hex[:12]}"
    intent_object: dict[str, object] = {
        "id": intent,
        "object": "payment_intent",
        "amount": amount,
        "currency": currency,
        "customer": customer,
        "metadata": metadata,
        "last_payment_error": {"code": failure_code} if failure_code else None,
    }
    return StripeEvent(
        stripe_event_id=event_id,
        event_type=event_type,
        livemode=False,
        created=datetime.now(UTC),
        payload={"id": event_id, "type": event_type, "data": {"object": intent_object}},
    )


async def deliver(session: AsyncSession, stripe_event: StripeEvent) -> None:
    """The worker's handler for the event's type, as process_stripe_event runs it."""
    handler = handler_for(stripe_event.event_type)
    assert handler is not None
    await handler(session, stripe_event, AfterCommit())


async def reread(session: AsyncSession, tip_id: uuid.UUID) -> Tip:
    statement = select(Tip).where(Tip.id == tip_id).execution_options(populate_existing=True)
    return (await session.scalars(statement)).one()


async def job_events(session: AsyncSession, job_id: uuid.UUID) -> list[JobEvent]:
    statement = (
        select(JobEvent)
        .where(JobEvent.job_id == job_id)
        .order_by(JobEvent.created_at, JobEvent.id)
        .execution_options(populate_existing=True)
    )
    return list((await session.scalars(statement)).all())


async def job_status(session: AsyncSession, job_id: uuid.UUID) -> JobStatus | None:
    return await session.scalar(
        select(Job.status).where(Job.id == job_id).execution_options(populate_existing=True)
    )


def messages(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [record.message for record in caplog.records]


async def test_a_succeeded_tip_adds_one_timeline_line_and_leaves_the_job_alone(
    db_session: AsyncSession, world: JobWorld, job: Job, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    tip = await add_tip(db_session, world, job)

    await deliver(db_session, event(SUCCEEDED, tip))
    await deliver(db_session, event(SUCCEEDED, tip))  # Stripe sends it again

    row = await reread(db_session, tip.id)
    assert row.status is TipStatus.SUCCEEDED
    assert row.succeeded_at is not None
    added = [e for e in await job_events(db_session, job.id) if e.type == "tip_added"]
    assert [(e.actor_id, e.from_status, e.to_status) for e in added] == [
        (world.customer.id, None, None)
    ]
    assert await job_status(db_session, job.id) is JobStatus.CONFIRMED
    assert "tip_succeeded" in messages(caplog)
    # Never read as a job payment's.
    assert not {"payment_event_unknown_intent", "payment_event_mismatch"} & set(messages(caplog))


@pytest.mark.parametrize(
    ("events", "expected"),
    [
        ([PROCESSING], TipStatus.PROCESSING),
        ([PROCESSING, SUCCEEDED], TipStatus.SUCCEEDED),
        ([FAILED], TipStatus.FAILED),
        ([FAILED, PROCESSING, SUCCEEDED], TipStatus.SUCCEEDED),
        ([CANCELED], TipStatus.CANCELED),
        ([PROCESSING, FAILED, CANCELED], TipStatus.CANCELED),
        # Nothing moves a tip on after succeeded or canceled.
        ([SUCCEEDED, PROCESSING, FAILED, CANCELED], TipStatus.SUCCEEDED),
        ([CANCELED, PROCESSING, SUCCEEDED], TipStatus.CANCELED),
    ],
)
async def test_the_tips_status_follows_its_intent(
    db_session: AsyncSession,
    world: JobWorld,
    job: Job,
    events: list[str],
    expected: TipStatus,
) -> None:
    tip = await add_tip(db_session, world, job)

    for event_type in events:
        await deliver(db_session, event(event_type, tip, failure_code="card_declined"))

    assert (await reread(db_session, tip.id)).status is expected
    # A tip's payment, failed or not, never changes the job.
    assert await job_status(db_session, job.id) is JobStatus.CONFIRMED


@pytest.mark.parametrize(
    ("amount", "currency", "customer", "fields"),
    [
        (AMOUNT + 1, "usd", STRIPE_CUSTOMER, ["amount"]),
        (AMOUNT, "eur", STRIPE_CUSTOMER, ["currency"]),
        (AMOUNT, "usd", "cus_someoneelse", ["customer"]),
        (AMOUNT, "usd", None, ["customer"]),
    ],
)
async def test_an_event_that_differs_from_the_tip_changes_nothing_and_fails(
    db_session: AsyncSession,
    world: JobWorld,
    job: Job,
    caplog: pytest.LogCaptureFixture,
    amount: int,
    currency: str,
    customer: str | None,
    fields: list[str],
) -> None:
    tip = await add_tip(db_session, world, job)

    stripe_event = event(SUCCEEDED, tip, amount=amount, currency=currency, customer=customer)

    with pytest.raises(TipEventMismatchError):
        await deliver(db_session, stripe_event)

    assert (await reread(db_session, tip.id)).status is TipStatus.REQUIRES_PAYMENT
    [record] = [r for r in caplog.records if r.message == "tip_event_mismatch"]
    assert record.__dict__["fields"] == fields


async def test_a_job_payments_event_never_touches_a_tip(
    db_session: AsyncSession, world: JobWorld, job: Job, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    tip = await add_tip(db_session, world, job)
    # A job payment's intent: no kind in its metadata (and none of its payments holds it here).
    payment_metadata = {"payment_id": str(uuid.uuid4())}

    await deliver(db_session, event(SUCCEEDED, tip, intent=INTENT, metadata=payment_metadata))

    assert (await reread(db_session, tip.id)).status is TipStatus.REQUIRES_PAYMENT
    assert "payment_event_unknown_intent" in messages(caplog)
    assert not [m for m in messages(caplog) if m.startswith("tip_")]


async def test_the_payment_handler_skips_a_tips_event(
    db_session: AsyncSession, world: JobWorld, job: Job, caplog: pytest.LogCaptureFixture
) -> None:
    """Even reached directly, the job payment's handler reads no payment for a tip's event."""
    caplog.set_level(logging.DEBUG)
    tip = await add_tip(db_session, world, job)

    await PAYMENT_INTENT_HANDLERS[SUCCEEDED](db_session, event(SUCCEEDED, tip), AfterCommit())

    assert (await reread(db_session, tip.id)).status is TipStatus.REQUIRES_PAYMENT
    assert "payment_event_other_kind" in messages(caplog)
    assert "payment_event_unknown_intent" not in messages(caplog)


async def test_a_lost_creates_intent_is_adopted_from_its_event(
    db_session: AsyncSession, world: JobWorld, job: Job, caplog: pytest.LogCaptureFixture
) -> None:
    tip = await add_tip(db_session, world, job, intent=None)

    await deliver(db_session, event(SUCCEEDED, tip))

    row = await reread(db_session, tip.id)
    assert (row.stripe_payment_intent_id, row.status) == (INTENT, TipStatus.SUCCEEDED)
    assert "tip_payment_intent_adopted_from_event" in messages(caplog)


async def test_an_earlier_attempts_canceled_intent_changes_nothing(
    db_session: AsyncSession, world: JobWorld, job: Job, caplog: pytest.LogCaptureFixture
) -> None:
    """The customer changed the amount: the first intent was canceled, the tip is at attempt 2
    with another intent, and the first intent's canceled event arrives late."""
    caplog.set_level(logging.INFO)
    tip = await add_tip(db_session, world, job, intent="pi_tipsecond", attempt=2)
    old = {"kind": "tip", "tip_id": str(tip.id), "job_id": str(job.id), "attempt": "1"}

    await deliver(db_session, event(CANCELED, tip, metadata=old))

    row = await reread(db_session, tip.id)
    assert (row.status, row.stripe_payment_intent_id) == (
        TipStatus.REQUIRES_PAYMENT,
        "pi_tipsecond",
    )
    assert "tip_event_stale_attempt" in messages(caplog)


async def test_an_earlier_attempts_intent_that_succeeded_fails_for_staff(
    db_session: AsyncSession, world: JobWorld, job: Job, caplog: pytest.LogCaptureFixture
) -> None:
    tip = await add_tip(db_session, world, job, intent=None, attempt=2)
    old = {"kind": "tip", "tip_id": str(tip.id), "job_id": str(job.id), "attempt": "1"}

    with pytest.raises(TipEventMismatchError):
        await deliver(db_session, event(SUCCEEDED, tip, metadata=old))

    row = await reread(db_session, tip.id)
    assert (row.status, row.stripe_payment_intent_id) == (TipStatus.REQUIRES_PAYMENT, None)
    [record] = [r for r in caplog.records if r.message == "tip_succeeded_on_stale_attempt"]
    assert record.levelno == logging.ERROR


@pytest.mark.parametrize("named", ["not-a-uuid", str(uuid.uuid4()), str(uuid.uuid4()).upper()])
async def test_an_intent_naming_no_tip_is_logged_and_ignored(
    db_session: AsyncSession,
    world: JobWorld,
    job: Job,
    caplog: pytest.LogCaptureFixture,
    named: str,
) -> None:
    tip = await add_tip(db_session, world, job)
    metadata = {"kind": "tip", "tip_id": named, "attempt": "1"}

    await deliver(db_session, event(SUCCEEDED, None, intent="pi_tipunknown", metadata=metadata))

    assert (await reread(db_session, tip.id)).status is TipStatus.REQUIRES_PAYMENT
    assert "tip_event_unknown_intent" in messages(caplog)


async def test_tip_webhook_logs_carry_ids_only(
    db_session: AsyncSession, world: JobWorld, job: Job, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    tip = await add_tip(db_session, world, job)

    await deliver(db_session, event(FAILED, tip, failure_code="card_declined"))
    await deliver(db_session, event(SUCCEEDED, tip))

    text = "\n".join(f"{r.message} {r.__dict__}" for r in caplog.records)
    assert INTENT not in text
    assert STRIPE_CUSTOMER not in text
    [failed] = [r for r in caplog.records if r.message == "tip_payment_failed"]
    assert failed.__dict__["stripe_code"] == "card_declined"
