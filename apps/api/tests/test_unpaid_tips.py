"""The unpaid tip sweep (#273, PR A1): the cron cancels, in Stripe, the PaymentIntent of a tip
left unpaid past PAYMENT_UNPAID_CANCEL_AFTER_SECONDS (the job payment's window, #297); the
canceled event then marks the tip canceled (test_tip_webhooks.py).

On the rolled-back test session, which the cron's session factory hands out (its commits only
release a savepoint), with the payment calls' Stripe fake. The window is long (30 days) and each
test ages its own tips past it.
"""

import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.modules.jobs.models import JobStatus
from app.modules.tips.models import Tip, TipChoice, TipStatus
from app.modules.tips.repository import TipRepository
from app.modules.tips.service import tip_cancel_idempotency_key
from app.modules.tips.tasks import cancel_unpaid_tips
from tests.conftest import make_settings
from tests.job_world import JobWorld, build_world, make_job
from tests.test_payments_api import FakeStripePayments, extra_of

WINDOW = timedelta(days=30)
AGED = WINDOW + timedelta(hours=1)


@pytest.fixture
def settings() -> Settings:
    return make_settings(payment_unpaid_cancel_after_seconds=int(WINDOW.total_seconds()))


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


async def add_tip(
    session: AsyncSession,
    world: JobWorld,
    *,
    status: TipStatus = TipStatus.REQUIRES_PAYMENT,
    intent: str | None = "auto",
    requested_ago: timedelta = AGED,
) -> Tip:
    at = datetime.now(UTC) - timedelta(days=40)
    job = await make_job(session, world, JobStatus.CONFIRMED, completed_at=at, confirmed_at=at)
    declined = status is TipStatus.DECLINED
    tip = Tip(
        job_id=job.id,
        request_id=job.request_id,
        customer_id=world.customer.id,
        pro_id=world.pro.profile_id,
        choice=TipChoice.NONE if declined else TipChoice.CUSTOM,
        amount_cents=0 if declined else 1_000,
        currency="usd",
        status=status,
        succeeded_at=datetime.now(UTC) if status is TipStatus.SUCCEEDED else None,
        stripe_payment_intent_id=f"pi_unpaidtip{uuid.uuid4().hex[:10]}"
        if intent == "auto"
        else intent,
        attempt=1,
        payment_intent_requested_at=datetime.now(UTC) - requested_ago,
    )
    session.add(tip)
    await session.flush()
    return tip


def context(
    session: AsyncSession, settings: Settings, stripe: FakeStripePayments | None
) -> dict[str, Any]:
    @asynccontextmanager
    async def sessions() -> AsyncIterator[AsyncSession]:
        yield session

    return {"session_factory": sessions, "settings": settings, "stripe_payments": stripe}


async def version_of(session: AsyncSession, tip_id: uuid.UUID) -> datetime:
    version = await session.scalar(
        select(Tip.updated_at).where(Tip.id == tip_id).execution_options(populate_existing=True)
    )
    assert version is not None
    return version


def summary(caplog: pytest.LogCaptureFixture) -> dict[str, object]:
    [record] = [r for r in caplog.records if r.message == "unpaid_tips_swept"]
    return extra_of(record)


async def test_a_tip_left_unpaid_is_canceled_in_stripe(
    db_session: AsyncSession, world: JobWorld, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    unpaid = await add_tip(db_session, world)
    failed = await add_tip(db_session, world, status=TipStatus.FAILED)
    stripe = FakeStripePayments()
    expected = sorted(
        [
            (
                tip.stripe_payment_intent_id,
                tip_cancel_idempotency_key(tip.id, 1, await version_of(db_session, tip.id)),
            )
            for tip in (unpaid, failed)
        ]
    )

    await cancel_unpaid_tips(context(db_session, settings, stripe))

    assert sorted(stripe.cancels) == expected
    assert summary(caplog) == {"canceled": 2, "skipped": 0, "failed": 0}
    # The canceled event marks the tip; the sweep changes nothing itself.
    for tip in (unpaid, failed):
        status = await db_session.scalar(select(Tip.status).where(Tip.id == tip.id))
        assert status in (TipStatus.REQUIRES_PAYMENT, TipStatus.FAILED)


@pytest.mark.parametrize(
    "fields",
    [
        {"requested_ago": WINDOW - timedelta(hours=1)},
        {"status": TipStatus.PROCESSING},
        {"status": TipStatus.SUCCEEDED},
        {"status": TipStatus.CANCELED},
        {"status": TipStatus.DECLINED, "intent": None},
        # A create with no answer stored: no intent to cancel.
        {"intent": None},
    ],
)
async def test_tips_not_due_are_left_alone(
    db_session: AsyncSession, world: JobWorld, settings: Settings, fields: dict[str, Any]
) -> None:
    await add_tip(db_session, world, **fields)
    stripe = FakeStripePayments()

    await cancel_unpaid_tips(context(db_session, settings, stripe))

    assert stripe.cancels == []


async def test_a_refused_cancel_is_skipped(
    db_session: AsyncSession, world: JobWorld, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    await add_tip(db_session, world)
    stripe = FakeStripePayments(cancel_refused=True)

    await cancel_unpaid_tips(context(db_session, settings, stripe))

    assert summary(caplog) == {"canceled": 0, "skipped": 1, "failed": 0}


@pytest.mark.parametrize(
    "error",
    [StripeUnavailableError(request_id="req_x"), StripeRejectedError(request_id="req_y", code="x")],
)
async def test_a_stripe_failure_is_logged_and_tried_next_run(
    db_session: AsyncSession,
    world: JobWorld,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
    error: Exception,
) -> None:
    caplog.set_level(logging.INFO)
    tip = await add_tip(db_session, world)
    stripe = FakeStripePayments(errors={"cancel_payment_intent": error})

    await cancel_unpaid_tips(context(db_session, settings, stripe))
    del stripe.errors["cancel_payment_intent"]
    caplog.clear()
    await cancel_unpaid_tips(context(db_session, settings, stripe))

    assert [intent for intent, _ in stripe.cancels] == [tip.stripe_payment_intent_id]
    assert summary(caplog) == {"canceled": 1, "skipped": 0, "failed": 0}


async def test_without_stripe_nothing_is_canceled(
    db_session: AsyncSession, world: JobWorld, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    await add_tip(db_session, world)

    await cancel_unpaid_tips(context(db_session, settings, None))

    assert summary(caplog) == {"canceled": 0, "skipped": 0, "failed": 1}
    assert "tip_unpaid_stripe_not_configured" in [r.message for r in caplog.records]


async def test_a_tip_paid_after_the_read_is_left_alone(
    db_session: AsyncSession, world: JobWorld, settings: Settings
) -> None:
    """The tip is read due, then its payment starts before the sweep locks it: checked again
    under the lock, it is not canceled."""
    tip = await add_tip(db_session, world)
    stripe = FakeStripePayments()
    original = TipRepository.unpaid_due

    async def read_then_pay(self: Any, *args: Any) -> list[uuid.UUID]:
        due: list[uuid.UUID] = await original(self, *args)
        await db_session.execute(
            update(Tip).where(Tip.id == tip.id).values(status=TipStatus.PROCESSING)
        )
        return due

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(TipRepository, "unpaid_due", read_then_pay)
        await cancel_unpaid_tips(context(db_session, settings, stripe))

    assert stripe.cancels == []
