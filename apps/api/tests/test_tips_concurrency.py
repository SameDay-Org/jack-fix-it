"""Two choices of one tip at once (#273, PR A1), on real commits and real row locks: the
customer's two devices, or a double tap. A choice that changes the amount waits for the other's
create, cancels its PaymentIntent in Stripe, and only then asks for its own, so at most one
PaymentIntent of the tip can be paid at a time. Stripe is the payment calls' fake."""

import asyncio
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select, update

from app.modules.jobs.models import Job, JobStatus
from app.modules.tips.models import Tip
from app.modules.tips.schemas import CustomTipIn, NoTipIn, PercentTipIn, TipCreateOut
from app.modules.tips.service import TipConfig, TipService
from app.modules.users.models import User
from tests.helpers import as_status_writer
from tests.test_job_state_concurrency import (
    CommittedJob,
    backend_pid,
    committed_job,
    wait_until_blocked,
)
from tests.test_payments_api import PUBLISHABLE_KEY, FakeStripePayments

__all__ = ["committed_job"]  # a fixture, used by name

CONFIG = TipConfig(
    presets=(5, 10, 15),
    min_cents=100,
    max_percent=100,
    max_cents=50_000,
    window=timedelta(hours=168),
    publishable_key=PUBLISHABLE_KEY,
    intent_reconcile_after=timedelta(hours=5),
)
TEN_PERCENT = PercentTipIn(choice="percent", percent=10)  # the job's 10,000 -> 1,000


@dataclass(frozen=True)
class TipJob:
    world: CommittedJob
    request_id: uuid.UUID


@pytest.fixture
async def tip_job(committed_job: CommittedJob) -> AsyncIterator[TipJob]:
    """The committed job, confirmed, its customer with a Stripe Customer; its tip deleted
    afterwards (before the job's own teardown)."""
    async with committed_job.sessions() as session:
        async with as_status_writer(session):
            await session.execute(
                update(Job)
                .where(Job.id == committed_job.job_id)
                .values(status=JobStatus.CONFIRMED, confirmed_at=datetime.now(UTC))
            )
        await session.execute(
            update(User)
            .where(User.id == committed_job.customer.id)
            .values(stripe_customer_id="cus_tipconcurrency")
        )
        request_id = await session.scalar(
            select(Job.request_id).where(Job.id == committed_job.job_id)
        )
        await session.commit()
    assert request_id is not None
    try:
        yield TipJob(committed_job, request_id)
    finally:
        async with committed_job.sessions() as session:
            await session.execute(delete(Tip).where(Tip.job_id == committed_job.job_id))
            await session.commit()


async def choose(
    tip_job: TipJob,
    stripe: FakeStripePayments,
    body: NoTipIn | PercentTipIn | CustomTipIn,
    pids: dict[str, int],
    name: str,
    started: asyncio.Event | None = None,
) -> TipCreateOut:
    async with tip_job.world.sessions() as session:
        pids[name] = await backend_pid(session)
        await session.commit()
        if started is not None:
            started.set()
        service = TipService(session, stripe, CONFIG)
        return await service.choose(tip_job.world.customer, tip_job.request_id, body)


async def tip_row(tip_job: TipJob) -> Tip:
    async with tip_job.world.sessions() as session:
        tip = await session.scalar(select(Tip).where(Tip.job_id == tip_job.world.job_id))
    assert tip is not None
    return tip


@pytest.mark.parametrize(
    "second",
    [CustomTipIn(choice="custom", amount_cents=1_250), NoTipIn(choice="none")],
    ids=["new_amount", "no_tip"],
)
async def test_a_change_during_a_create_waits_then_cancels_it_before_its_own(
    tip_job: TipJob, second: CustomTipIn | NoTipIn
) -> None:
    stripe = FakeStripePayments()
    entered, release = asyncio.Event(), asyncio.Event()
    order: list[str] = []

    async def first_create_in_flight() -> None:
        order.append("create")
        entered.set()
        await release.wait()

    async def cancel() -> None:
        order.append("cancel")

    async def later_create() -> None:
        order.append("create")

    stripe.on_create_intent, stripe.on_cancel_intent = first_create_in_flight, cancel
    pids: dict[str, int] = {}
    first = asyncio.create_task(choose(tip_job, stripe, TEN_PERCENT, pids, "first"))
    try:
        await asyncio.wait_for(entered.wait(), 10)
        stripe.on_create_intent = later_create
        started = asyncio.Event()
        later = asyncio.create_task(choose(tip_job, stripe, second, pids, "second", started))
        await asyncio.wait_for(started.wait(), 10)
        # The first holds the tip's row over its create: the second waits for it.
        await wait_until_blocked(
            tip_job.world.sessions, waiter=pids["second"], holder=pids["first"]
        )
        release.set()
        kept = await asyncio.wait_for(first, 10)
        changed = await asyncio.wait_for(later, 10)
    finally:
        release.set()

    assert kept.sheet is not None
    assert kept.sheet.amount_cents == 1_000
    tip = await tip_row(tip_job)
    [(canceled, _)] = stripe.cancels
    # The first choice's intent, the one its sheet holds.
    assert canceled == stripe.intents_by_key[f"tip:{tip.id}:1"]
    if isinstance(second, NoTipIn):
        assert changed.sheet is None
        assert order == ["create", "cancel"]
        assert (tip.stripe_payment_intent_id, tip.amount_cents) == (None, 0)
    else:
        assert changed.sheet is not None
        assert changed.sheet.amount_cents == 1_250
        # The first intent is canceled before the second is asked for.
        assert order == ["create", "cancel", "create"]
        assert (tip.attempt, tip.amount_cents) == (2, 1_250)
        assert tip.stripe_payment_intent_id == stripe.intents_by_key[f"tip:{tip.id}:2"]
        assert tip.stripe_payment_intent_id != canceled


async def test_two_first_choices_at_once_make_one_tip_and_one_intent(tip_job: TipJob) -> None:
    stripe = FakeStripePayments()
    pids: dict[str, int] = {}

    answers = await asyncio.gather(
        choose(tip_job, stripe, TEN_PERCENT, pids, "a"),
        choose(tip_job, stripe, TEN_PERCENT, pids, "b"),
    )

    secrets = {answer.sheet.payment_intent_client_secret for answer in answers if answer.sheet}
    assert len(secrets) == 1
    assert len(stripe.intents) == 1
    assert stripe.cancels == []
    tip = await tip_row(tip_job)
    assert tip.attempt == 1
