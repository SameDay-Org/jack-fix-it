"""payment_intent.* events of a tip's PaymentIntent (#273, PR A1; #510 round 1): routed by
metadata kind to the tips module, which reads the PaymentIntent from Stripe (the payment calls'
fake here) before anything is stored or settled. On the rolled-back test session (a handler
never commits)."""

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.stripe_errors import StripeUnavailableError
from app.integrations.stripe_payments import TipIntentFacts
from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.payments.webhook_handlers import PAYMENT_INTENT_HANDLERS
from app.modules.tips.errors import TipEventMismatchError
from app.modules.tips.models import Tip, TipChoice, TipStatus
from app.modules.tips.webhooks import TipsStripeNotConfiguredError, tip_event_handler
from app.modules.users.models import User
from app.modules.webhooks.events import AfterCommit, StripeEvent
from app.modules.webhooks.handlers import handler_for
from tests.job_world import JobWorld, build_world, make_job
from tests.test_payments_api import FakeStripePayments

STRIPE_CUSTOMER = "cus_tipwebhook273"
INTENT = "pi_tipwebhook273"
AMOUNT = 2_400
SUCCEEDED = "payment_intent.succeeded"
PROCESSING = "payment_intent.processing"
FAILED = "payment_intent.payment_failed"
CANCELED = "payment_intent.canceled"


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


def stripe_holds(
    stripe: FakeStripePayments,
    tip: Tip,
    *,
    intent: str = INTENT,
    status: str = "requires_payment_method",
    attempt: str | None = None,
    **overrides: object,
) -> None:
    """Stripe holds `intent`, made for `tip` (its current attempt unless `attempt`), in
    `status`; `overrides` change what Stripe shows of it."""
    facts = TipIntentFacts(
        payment_intent_id=intent,
        amount_cents=AMOUNT,
        currency="usd",
        customer_id=STRIPE_CUSTOMER,
        status=status,
        failed=False,
        kind="tip",
        tip_id=str(tip.id),
        job_id=str(tip.job_id),
        attempt=attempt or str(tip.attempt),
    )
    stripe.add_tip_intent(TipIntentFacts(**{**facts.__dict__, **overrides}))
    stripe.tip_statuses[intent] = status


def event(
    event_type: str,
    intent: str = INTENT,
    payload_status: str = "succeeded",
    metadata: dict[str, str] | None = None,
) -> StripeEvent:
    """An event as the route stores it. Its copy of the intent (status, metadata) is never
    what the handler acts on."""
    event_id = f"evt_tip{uuid.uuid4().hex[:12]}"
    intent_object: dict[str, object] = {
        "id": intent,
        "object": "payment_intent",
        "amount": AMOUNT,
        "currency": "usd",
        "customer": STRIPE_CUSTOMER,
        "status": payload_status,
        "metadata": {"kind": "tip"} if metadata is None else metadata,
    }
    return StripeEvent(
        stripe_event_id=event_id,
        event_type=event_type,
        livemode=False,
        created=datetime.now(UTC),
        payload={"id": event_id, "type": event_type, "data": {"object": intent_object}},
    )


async def deliver(
    session: AsyncSession, stripe: FakeStripePayments | None, stripe_event: StripeEvent
) -> None:
    """The tip handler bound to the fake, as the worker runs it."""
    await tip_event_handler(lambda: stripe)(session, stripe_event, AfterCommit())


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


# --- What Stripe says, never the event's copy -----------------------------------------------


async def test_a_succeeded_tip_adds_one_timeline_line_and_leaves_the_job_alone(
    db_session: AsyncSession, world: JobWorld, job: Job, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    tip = await add_tip(db_session, world, job)
    stripe = FakeStripePayments()
    stripe_holds(stripe, tip, status="succeeded")

    await deliver(db_session, stripe, event(SUCCEEDED))
    await deliver(db_session, stripe, event(SUCCEEDED))  # Stripe sends it again

    row = await reread(db_session, tip.id)
    assert row.status is TipStatus.SUCCEEDED
    assert row.succeeded_at is not None
    added = [e for e in await job_events(db_session, job.id) if e.type == "tip_added"]
    assert [(e.actor_id, e.from_status, e.to_status) for e in added] == [
        (world.customer.id, None, None)
    ]
    assert await job_status(db_session, job.id) is JobStatus.CONFIRMED
    # Read from Stripe each time.
    assert stripe.tip_reads == [INTENT, INTENT]
    assert "tip_succeeded" in messages(caplog)
    assert not {"payment_event_unknown_intent", "payment_event_mismatch"} & set(messages(caplog))


@pytest.mark.parametrize(
    ("stripe_says", "failed", "expected"),
    [
        ("processing", False, TipStatus.PROCESSING),
        ("succeeded", False, TipStatus.SUCCEEDED),
        ("canceled", False, TipStatus.CANCELED),
        ("requires_payment_method", True, TipStatus.FAILED),
        ("requires_payment_method", False, TipStatus.REQUIRES_PAYMENT),
        ("requires_action", False, TipStatus.REQUIRES_PAYMENT),
    ],
)
@pytest.mark.parametrize("event_type", [SUCCEEDED, PROCESSING, FAILED, CANCELED])
async def test_the_tip_takes_the_status_stripe_has_now_whatever_the_event(
    db_session: AsyncSession,
    world: JobWorld,
    job: Job,
    event_type: str,
    stripe_says: str,
    failed: bool,
    expected: TipStatus,
) -> None:
    tip = await add_tip(db_session, world, job)
    stripe = FakeStripePayments()
    stripe_holds(stripe, tip, status=stripe_says)
    if failed:
        stripe.failed_intents.add(INTENT)

    await deliver(db_session, stripe, event(event_type, payload_status="succeeded"))

    assert (await reread(db_session, tip.id)).status is expected
    # A tip's payment, failed or not, never changes the job.
    assert await job_status(db_session, job.id) is JobStatus.CONFIRMED


async def test_an_older_failure_after_a_retry_that_is_processing_moves_nothing(
    db_session: AsyncSession, world: JobWorld, job: Job
) -> None:
    """The Gatekeeper's case: a failed tip reuses its intent; the retry's processing event is
    handled, then the first try's payment_failed arrives while Stripe still says processing."""
    tip = await add_tip(db_session, world, job, status=TipStatus.FAILED)
    stripe = FakeStripePayments()
    stripe_holds(stripe, tip, status="processing")

    await deliver(db_session, stripe, event(PROCESSING))
    await deliver(db_session, stripe, event(FAILED, payload_status="requires_payment_method"))

    assert (await reread(db_session, tip.id)).status is TipStatus.PROCESSING
    assert len(stripe.tip_reads) == 2


@pytest.mark.parametrize("final", ["succeeded", "canceled"])
async def test_nothing_moves_a_tip_once_succeeded_or_canceled(
    db_session: AsyncSession, world: JobWorld, job: Job, final: str
) -> None:
    tip = await add_tip(db_session, world, job)
    stripe = FakeStripePayments()
    stripe_holds(stripe, tip, status=final)
    await deliver(db_session, stripe, event(SUCCEEDED))
    stripe.tip_statuses[INTENT] = "processing"  # a Stripe answer that is not possible after it

    await deliver(db_session, stripe, event(PROCESSING))

    assert (await reread(db_session, tip.id)).status.value == final


async def test_a_failed_read_settles_nothing_and_the_event_is_run_again(
    db_session: AsyncSession, world: JobWorld, job: Job, caplog: pytest.LogCaptureFixture
) -> None:
    tip = await add_tip(db_session, world, job)
    stripe = FakeStripePayments()
    stripe_holds(stripe, tip, status="succeeded")
    stripe.errors["tip_intent"] = StripeUnavailableError(request_id="req_down")

    with pytest.raises(StripeUnavailableError):
        await deliver(db_session, stripe, event(SUCCEEDED))

    assert (await reread(db_session, tip.id)).status is TipStatus.REQUIRES_PAYMENT
    assert "tip_event_stripe_unavailable" in messages(caplog)


async def test_without_stripe_the_event_is_run_again_later(
    db_session: AsyncSession, world: JobWorld, job: Job
) -> None:
    tip = await add_tip(db_session, world, job)

    with pytest.raises(TipsStripeNotConfiguredError):
        await deliver(db_session, None, event(SUCCEEDED))

    assert (await reread(db_session, tip.id)).status is TipStatus.REQUIRES_PAYMENT


@pytest.mark.parametrize(
    ("override", "fields"),
    [
        ({"job_id": str(uuid.uuid4())}, ["job"]),
        ({"customer_id": "cus_someoneelse"}, ["customer"]),
        ({"customer_id": None}, ["customer"]),
        ({"currency": "eur"}, ["currency"]),
        ({"amount_cents": AMOUNT + 1}, ["amount"]),
        ({"kind": None}, ["kind"]),
        # An attempt the tip never reached.
        ({"attempt": "7"}, ["attempt"]),
    ],
)
async def test_an_intent_that_is_not_this_tip_s_changes_nothing_and_fails(
    db_session: AsyncSession,
    world: JobWorld,
    job: Job,
    caplog: pytest.LogCaptureFixture,
    override: dict[str, Any],
    fields: list[str],
) -> None:
    tip = await add_tip(db_session, world, job)
    stripe = FakeStripePayments()
    stripe_holds(stripe, tip, status="succeeded", **override)

    with pytest.raises(TipEventMismatchError):
        await deliver(db_session, stripe, event(SUCCEEDED))

    assert (await reread(db_session, tip.id)).status is TipStatus.REQUIRES_PAYMENT
    [record] = [r for r in caplog.records if r.message == "tip_event_mismatch"]
    assert record.__dict__["fields"] == fields


# --- Whose intent: a lost create, an earlier attempt, another job ----------------------------


async def test_a_lost_creates_intent_is_adopted_once_stripe_shows_it_is_this_attempt_s(
    db_session: AsyncSession, world: JobWorld, job: Job, caplog: pytest.LogCaptureFixture
) -> None:
    tip = await add_tip(db_session, world, job, intent=None)
    stripe = FakeStripePayments()
    stripe_holds(stripe, tip, status="succeeded")

    await deliver(db_session, stripe, event(SUCCEEDED))

    row = await reread(db_session, tip.id)
    assert (row.stripe_payment_intent_id, row.status) == (INTENT, TipStatus.SUCCEEDED)
    assert "tip_payment_intent_adopted_from_event" in messages(caplog)


async def test_another_job_s_intent_is_never_adopted(
    db_session: AsyncSession, world: JobWorld, job: Job
) -> None:
    """The Vault's case: a tip waits on a lost create; an intent whose metadata names it but
    that Stripe shows made for another job is refused, not adopted."""
    tip = await add_tip(db_session, world, job, intent=None)
    stripe = FakeStripePayments()
    stripe_holds(stripe, tip, intent="pi_tipforeign", status="succeeded", job_id=str(uuid.uuid4()))

    with pytest.raises(TipEventMismatchError):
        await deliver(db_session, stripe, event(SUCCEEDED, intent="pi_tipforeign"))

    row = await reread(db_session, tip.id)
    assert (row.stripe_payment_intent_id, row.status) == (None, TipStatus.REQUIRES_PAYMENT)
    assert [e for e in await job_events(db_session, job.id) if e.type == "tip_added"] == []


async def test_an_earlier_attempts_canceled_intent_changes_nothing(
    db_session: AsyncSession, world: JobWorld, job: Job, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    tip = await add_tip(db_session, world, job, intent="pi_tipsecond", attempt=2)
    stripe = FakeStripePayments()
    stripe_holds(stripe, tip, status="canceled", attempt="1")

    await deliver(db_session, stripe, event(CANCELED))

    row = await reread(db_session, tip.id)
    assert (row.status, row.stripe_payment_intent_id, row.late_success_at) == (
        TipStatus.REQUIRES_PAYMENT,
        "pi_tipsecond",
        None,
    )
    assert "tip_event_stale_attempt" in messages(caplog)


async def test_an_earlier_attempts_success_is_contained_and_flagged_for_staff(
    db_session: AsyncSession, world: JobWorld, job: Job, caplog: pytest.LogCaptureFixture
) -> None:
    """Money no attempt holds: the tip is flagged (and takes no new choice), its current
    attempt's intent is canceled so it can never be paid too, and staff get an ERROR."""
    tip = await add_tip(db_session, world, job, intent="pi_tipsecond", attempt=2)
    stripe = FakeStripePayments()
    stripe_holds(stripe, tip, status="succeeded", attempt="1")
    stripe_holds(stripe, tip, intent="pi_tipsecond", status="requires_payment_method")

    after = AfterCommit()
    await tip_event_handler(lambda: stripe)(db_session, event(SUCCEEDED), after)
    await deliver(db_session, stripe, event(SUCCEEDED))  # again: flagged and canceled once
    # Staff's: no receipt, no transfer, no push (#273 PR A2).
    assert not after.actions

    row = await reread(db_session, tip.id)
    assert row.late_success_at is not None
    assert row.status is TipStatus.REQUIRES_PAYMENT  # the canceled event moves it on
    assert [intent for intent, _ in stripe.cancels] == ["pi_tipsecond"]
    errors = [r for r in caplog.records if r.message == "tip_succeeded_on_stale_attempt"]
    assert [(r.levelno, r.__dict__["current_canceled"]) for r in errors] == [
        (logging.ERROR, "true"),
        (logging.ERROR, "false"),
    ]
    # Its own canceled event then marks the current attempt canceled.
    await deliver(db_session, stripe, event(CANCELED, intent="pi_tipsecond"))
    assert (await reread(db_session, tip.id)).status is TipStatus.CANCELED


@pytest.mark.parametrize("stripe_says", ["canceled", "succeeded"])
async def test_an_earlier_attempts_intent_is_never_adopted_for_a_lost_create(
    db_session: AsyncSession, world: JobWorld, job: Job, stripe_says: str
) -> None:
    """The current attempt (2) waits on a lost create; attempt 1's intent speaks up. It is
    not this attempt's, so it is never stored as the tip's (a success is contained instead)."""
    tip = await add_tip(db_session, world, job, intent=None, attempt=2)
    stripe = FakeStripePayments()
    stripe_holds(stripe, tip, status=stripe_says, attempt="1")

    await deliver(db_session, stripe, event(SUCCEEDED))

    row = await reread(db_session, tip.id)
    assert (row.stripe_payment_intent_id, row.status) == (None, TipStatus.REQUIRES_PAYMENT)
    assert (row.late_success_at is not None) is (stripe_says == "succeeded")


@pytest.mark.parametrize(
    "override",
    [{"tip_id": "not-a-uuid"}, {"tip_id": str(uuid.uuid4())}, {"tip_id": None}, {"kind": None}],
)
async def test_an_intent_naming_no_tip_of_ours_is_logged_and_ignored(
    db_session: AsyncSession,
    world: JobWorld,
    job: Job,
    caplog: pytest.LogCaptureFixture,
    override: dict[str, Any],
) -> None:
    tip = await add_tip(db_session, world, job)
    stripe = FakeStripePayments()
    stripe_holds(stripe, tip, intent="pi_tipunknown", status="succeeded", **override)

    await deliver(db_session, stripe, event(SUCCEEDED, intent="pi_tipunknown"))

    assert (await reread(db_session, tip.id)).status is TipStatus.REQUIRES_PAYMENT
    assert "tip_event_unknown_intent" in messages(caplog)


# --- Routing ----------------------------------------------------------------------------------


async def test_the_registry_routes_a_tips_event_to_the_tips_handler(
    db_session: AsyncSession, world: JobWorld, job: Job
) -> None:
    """The worker's own handler: it reads Stripe with the worker's client, which the test
    settings leave unconfigured, so the event is to be run again; no payment is read."""
    await add_tip(db_session, world, job)
    handler = handler_for(SUCCEEDED)
    assert handler is not None

    with pytest.raises(TipsStripeNotConfiguredError):
        await handler(db_session, event(SUCCEEDED), AfterCommit())


async def test_a_job_payments_event_never_touches_a_tip(
    db_session: AsyncSession, world: JobWorld, job: Job, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    tip = await add_tip(db_session, world, job)
    payment_event = event(SUCCEEDED, metadata={"payment_id": str(uuid.uuid4())})
    handler = handler_for(SUCCEEDED)
    assert handler is not None

    await handler(db_session, payment_event, AfterCommit())

    assert (await reread(db_session, tip.id)).status is TipStatus.REQUIRES_PAYMENT
    assert "payment_event_unknown_intent" in messages(caplog)
    assert not [m for m in messages(caplog) if m.startswith("tip_")]


async def test_the_payment_handler_skips_a_tips_event(
    db_session: AsyncSession, world: JobWorld, job: Job, caplog: pytest.LogCaptureFixture
) -> None:
    """Even reached directly, the job payment's handler reads no payment for a tip's event."""
    caplog.set_level(logging.DEBUG)
    tip = await add_tip(db_session, world, job)

    await PAYMENT_INTENT_HANDLERS[SUCCEEDED](db_session, event(SUCCEEDED), AfterCommit())

    assert (await reread(db_session, tip.id)).status is TipStatus.REQUIRES_PAYMENT
    assert "payment_event_other_kind" in messages(caplog)
    assert "payment_event_unknown_intent" not in messages(caplog)


async def test_tip_webhook_logs_carry_ids_only(
    db_session: AsyncSession, world: JobWorld, job: Job, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    tip = await add_tip(db_session, world, job)
    stripe = FakeStripePayments()
    stripe_holds(stripe, tip, status="processing")

    await deliver(db_session, stripe, event(PROCESSING))
    stripe.tip_statuses[INTENT] = "succeeded"
    await deliver(db_session, stripe, event(SUCCEEDED))

    text = "\n".join(f"{r.message} {r.__dict__}" for r in caplog.records)
    assert INTENT not in text
    assert STRIPE_CUSTOMER not in text
