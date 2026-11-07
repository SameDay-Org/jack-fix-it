"""The unpaid payment sweep (#297): the cron that cancels payments still unpaid past
PAYMENT_UNPAID_CANCEL_AFTER_SECONDS, so the quote and the request reopen.

On real commits: the payment webhooks' market (an accepted request, pro A's accepted quote, pros
B's and C's pending quotes, and quote A's payment with its PaymentIntent) and, where a second
request is needed, the payment calls' committed request; both delete their rows afterwards. The
window is long (30 days) and each test ages its own payments past it, so a payment another test
left behind is never due. Stripe is the payment calls' fake; no network.
"""

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.modules.payments import tasks
from app.modules.payments.errors import PaymentNotAvailableError
from app.modules.payments.models import Payment, PaymentStatus
from app.modules.payments.reconciliation import PaymentReconciler, UnpaidCheck, UnpaidOutcome
from app.modules.payments.repository import PaymentRepository
from app.modules.payments.schemas import PaymentSheetOut
from app.modules.payments.service import PaymentService, payment_intent_cancel_idempotency_key
from app.modules.payments.tasks import cancel_unpaid_payments
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.requests.models import RequestStatus, ServiceRequest
from app.money import split_amount
from app.observability import JsonFormatter
from tests.conftest import LOCK_WAIT_DEADLINE_SECONDS, backend_pid, make_settings
from tests.helpers import as_status_writer
from tests.test_payment_webhooks import (
    AMOUNT_CENTS,
    CANCELED,
    FAILED,
    MAX_ATTEMPTS,
    PROCESSING,
    SECRET,
    SUCCEEDED,
    TAKE_RATE_BPS,
    Market,
    market,
    records,
    wait_until_any_waits_on,
)
from tests.test_payments_api import CONFIG, PUBLISHABLE_KEY, FakeStripePayments, extra_of
from tests.test_payments_concurrency import Committed, committed

__all__ = ["committed", "market"]  # fixtures, used by name

WINDOW = timedelta(days=30)
AGED = WINDOW + timedelta(hours=1)
COUNTS = ("canceled_remote", "canceled_local", "skipped", "unresolved", "failed")
ALL_PENDING = [QuoteStatus.PENDING] * 3
STILL_ACCEPTED = [QuoteStatus.ACCEPTED, QuoteStatus.PENDING, QuoteStatus.PENDING]


@pytest.fixture
def settings() -> Settings:
    """The webhooks' settings (the market's events), plus the sweep's window."""
    return make_settings(
        stripe_webhook_secret=SECRET,
        stripe_webhook_max_attempts=MAX_ATTEMPTS,
        stripe_publishable_key=PUBLISHABLE_KEY,
        payment_unpaid_cancel_after_seconds=int(WINDOW.total_seconds()),
    )


def context(
    sessions: async_sessionmaker[AsyncSession], settings: Settings, stripe: FakeStripePayments
) -> dict[str, Any]:
    """What the worker's startup puts in the cron's context."""
    return {"session_factory": sessions, "settings": settings, "stripe_payments": stripe}


async def sweep(market: Market, stripe: FakeStripePayments) -> None:
    await cancel_unpaid_payments(context(market.sessions, market.settings, stripe))


async def set_payment(market: Market, **values: object) -> None:
    async with market.sessions() as session:
        await session.execute(
            update(Payment).where(Payment.id == market.payment_id).values(**values)
        )
        await session.commit()


def aged(by: timedelta = AGED) -> datetime:
    return datetime.now(UTC) - by


async def cancel_key(sessions: async_sessionmaker[AsyncSession], payment_id: uuid.UUID) -> str:
    """The key the sweep sends for this payment as it stands now."""
    async with sessions() as session:
        version = await session.scalar(select(Payment.updated_at).where(Payment.id == payment_id))
    assert version is not None
    return payment_intent_cancel_idempotency_key(payment_id, version)


def summary(caplog: pytest.LogCaptureFixture) -> dict[str, object]:
    """The counts of the last run."""
    return extra_of(records(caplog, "unpaid_payments_swept")[-1])


def counts(**nonzero: int) -> dict[str, object]:
    return {name: nonzero.get(name, 0) for name in COUNTS}


async def add_payment(
    committed: Committed, *, intent_id: str | None, created_at: datetime
) -> uuid.UUID:
    """A payment for the committed request's accepted quote, as a payment call leaves it."""
    split = split_amount(AMOUNT_CENTS, TAKE_RATE_BPS)
    async with committed.sessions() as session:
        payment = Payment(
            request_id=committed.request_id,
            quote_id=committed.quote_id,
            customer_id=committed.customer.id,
            amount_cents=AMOUNT_CENTS,
            tax_cents=0,
            customer_total_cents=AMOUNT_CENTS,
            platform_fee_cents=split.platform_fee_cents,
            pro_payout_cents=split.pro_payout_cents,
            take_rate_bps=TAKE_RATE_BPS,
            currency="usd",
            status=PaymentStatus.REQUIRES_PAYMENT,
            stripe_payment_intent_id=intent_id,
            created_at=created_at,
        )
        session.add(payment)
        await session.commit()
    return payment.id


async def committed_payment(committed: Committed, payment_id: uuid.UUID) -> Payment:
    async with committed.sessions() as session:
        payment = await session.get(Payment, payment_id, populate_existing=True)
    assert payment is not None
    return payment


async def committed_statuses(committed: Committed) -> tuple[RequestStatus, QuoteStatus]:
    async with committed.sessions() as session:
        request = await session.get(ServiceRequest, committed.request_id, populate_existing=True)
        quote = await session.get(Quote, committed.quote_id, populate_existing=True)
    assert request is not None
    assert quote is not None
    return request.status, quote.status


@pytest.mark.parametrize("failed_first", [False, True])
async def test_unpaid_payment_past_the_window_is_canceled_in_stripe(
    market: Market, failed_first: bool, caplog: pytest.LogCaptureFixture
) -> None:
    """requires_payment, or failed (the customer may retry): the cancel goes to Stripe with the
    payment's key; nothing changes until Stripe's canceled event, which reopens the quote."""
    if failed_first:
        assert await market.deliver(FAILED, failure_code="card_declined") == "processed"
    unpaid = PaymentStatus.FAILED if failed_first else PaymentStatus.REQUIRES_PAYMENT
    await set_payment(market, created_at=aged())
    stripe = FakeStripePayments()
    caplog.set_level(logging.INFO)

    await sweep(market, stripe)

    key = await cancel_key(market.sessions, market.payment_id)
    assert key.startswith(f"payment_intent_cancel:{market.payment_id}:")
    assert stripe.cancels == [(market.intent_id, key)]
    state = await market.state()
    assert (state.payment, state.request, state.quotes) == (
        unpaid,
        RequestStatus.ACCEPTED,
        STILL_ACCEPTED,
    )
    assert summary(caplog) == counts(canceled_remote=1)
    [requested] = records(caplog, "payment_unpaid_cancel_requested")
    assert extra_of(requested) == {
        "payment_id": str(market.payment_id),
        "quote_id": str(market.accepted_quote),
        "service_request_id": str(market.request_id),
    }

    assert await market.deliver(CANCELED) == "processed"

    state = await market.state()
    assert (state.payment, state.request, state.quotes) == (
        PaymentStatus.CANCELED,
        RequestStatus.QUOTE_READY,
        ALL_PENDING,
    )


async def test_no_lock_is_held_over_the_stripe_cancel(market: Market) -> None:
    """When Stripe is called, the sweep's transaction is over: another connection locks the
    request, the quote and the payment at once (NOWAIT)."""
    await set_payment(market, created_at=aged())
    stripe = FakeStripePayments()
    seen: list[int] = []

    async def lock_from_another_connection() -> None:
        async with market.sessions() as other:
            rows = (
                await other.execute(
                    text(
                        "SELECT p.id FROM service_requests r "
                        "JOIN quotes q ON q.request_id = r.id "
                        "JOIN payments p ON p.quote_id = q.id "
                        "WHERE p.id = :payment_id FOR UPDATE NOWAIT"
                    ),
                    {"payment_id": market.payment_id},
                )
            ).all()
            await other.rollback()
        seen.append(len(rows))

    stripe.on_cancel_intent = lock_from_another_connection

    await sweep(market, stripe)

    assert seen == [1]
    assert len(stripe.cancels) == 1


async def test_close_unpaid_rechecks_the_age_under_the_lock(market: Market) -> None:
    """A payment the cutoff does not cover is not due, whoever names it."""
    await set_payment(market, stripe_payment_intent_id=None)
    async with market.sessions() as session:
        check = await PaymentReconciler(session).close_unpaid(market.payment_id, aged())
        await session.commit()

    assert check.outcome is UnpaidOutcome.NOT_DUE
    assert (await market.state()).payment is PaymentStatus.REQUIRES_PAYMENT


@pytest.mark.parametrize("quote_expired", [False, True])
async def test_payment_without_an_intent_is_canceled_locally_and_the_quote_reopens(
    market: Market, quote_expired: bool, caplog: pytest.LogCaptureFixture
) -> None:
    """No PaymentIntent and no create ever attempted: nothing exists in Stripe, so the payment
    is canceled here and the quote reopens as for the canceled event: pending before its
    expires_at (the request quote_ready), else expired, and with no live quote left the request
    backs out to finding_pro."""
    await set_payment(market, stripe_payment_intent_id=None, created_at=aged())
    if quote_expired:
        async with market.sessions() as session:
            await session.execute(
                update(Quote)
                .where(Quote.id == market.accepted_quote)
                .values(expires_at=aged(timedelta(minutes=1)))
            )
            await session.execute(
                update(Quote)
                .where(Quote.id.in_(market.quote_ids[1:]))
                .values(status=QuoteStatus.WITHDRAWN)
            )
            await session.commit()
    stripe = FakeStripePayments()
    caplog.set_level(logging.INFO)

    await sweep(market, stripe)

    assert (stripe.cancels, stripe.intent_calls, stripe.searches) == ([], [], [])
    state = await market.state()
    assert state.payment is PaymentStatus.CANCELED
    if quote_expired:
        assert state.quotes == [QuoteStatus.EXPIRED, QuoteStatus.WITHDRAWN, QuoteStatus.WITHDRAWN]
        assert state.request is RequestStatus.FINDING_PRO
    else:
        assert state.quotes == ALL_PENDING
        assert state.request is RequestStatus.QUOTE_READY
    assert summary(caplog) == counts(canceled_local=1)
    assert len(records(caplog, "payment_canceled_quote_reopened")) == 1


async def test_lost_create_is_skipped_and_logged(
    market: Market, caplog: pytest.LogCaptureFixture
) -> None:
    """A create attempted with no answer stored: the intent may exist in Stripe, so the sweep
    changes nothing and calls nothing (no create, no search, no cancel); #296, the payment
    call's search or staff resolve it."""
    await set_payment(
        market,
        stripe_payment_intent_id=None,
        payment_intent_requested_at=aged(),
        created_at=aged(),
    )
    stripe = FakeStripePayments()
    caplog.set_level(logging.INFO)

    await sweep(market, stripe)

    assert (stripe.cancels, stripe.intent_calls, stripe.searches) == ([], [], [])
    state = await market.state()
    assert (state.payment, state.request, state.quotes) == (
        PaymentStatus.REQUIRES_PAYMENT,
        RequestStatus.ACCEPTED,
        STILL_ACCEPTED,
    )
    [unresolved] = records(caplog, "payment_unpaid_unresolved")
    assert unresolved.levelno == logging.WARNING
    assert extra_of(unresolved) == {
        "payment_id": str(market.payment_id),
        "quote_id": str(market.accepted_quote),
        "service_request_id": str(market.request_id),
    }
    assert summary(caplog) == counts(unresolved=1)


@pytest.mark.parametrize("event_type", [PROCESSING, SUCCEEDED, CANCELED])
async def test_processing_succeeded_and_canceled_payments_are_untouched(
    market: Market, event_type: str, caplog: pytest.LogCaptureFixture
) -> None:
    """Processing (Stripe may still take the money), succeeded or canceled: never selected."""
    assert await market.deliver(event_type) == "processed"
    await set_payment(market, created_at=aged())
    before = await market.state()
    stripe = FakeStripePayments()
    caplog.set_level(logging.INFO)

    await sweep(market, stripe)

    assert stripe.cancels == []
    after = await market.state()
    assert (after.payment, after.request, after.quotes, len(after.jobs)) == (
        before.payment,
        before.request,
        before.quotes,
        len(before.jobs),
    )
    assert summary(caplog) == counts()


@pytest.mark.parametrize("event_type", [PROCESSING, SUCCEEDED, CANCELED])
async def test_a_payment_settled_after_the_read_is_left_alone(
    market: Market,
    event_type: str,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The batch read the payment unpaid, and its event moved it on before the lock: the status
    read again under the lock leaves it alone."""
    assert await market.deliver(event_type) == "processed"
    await set_payment(market, created_at=aged())
    before = await market.state()

    async def stale_read(
        self: PaymentRepository, created_before: datetime, after: uuid.UUID | None, limit: int
    ) -> list[uuid.UUID]:
        return [market.payment_id] if after is None else []

    monkeypatch.setattr(PaymentRepository, "unpaid_due", stale_read)
    stripe = FakeStripePayments()
    caplog.set_level(logging.INFO)

    await sweep(market, stripe)

    assert stripe.cancels == []
    after = await market.state()
    assert (after.payment, after.request, after.quotes) == (
        before.payment,
        before.request,
        before.quotes,
    )
    assert summary(caplog) == counts(skipped=1)


@pytest.mark.parametrize("with_intent", [True, False])
async def test_payment_whose_request_moved_on_is_untouched(
    market: Market, with_intent: bool, caplog: pytest.LogCaptureFixture
) -> None:
    """The request no longer waits on the payment's quote (cancelled here): left alone, re-read
    under the locks."""
    await set_payment(
        market,
        created_at=aged(),
        stripe_payment_intent_id=market.intent_id if with_intent else None,
    )
    async with market.sessions() as session:
        async with as_status_writer(session):
            await session.execute(
                update(ServiceRequest)
                .where(ServiceRequest.id == market.request_id)
                .values(status=RequestStatus.CANCELLED)
            )
        await session.commit()
    stripe = FakeStripePayments()
    caplog.set_level(logging.INFO)

    await sweep(market, stripe)

    assert stripe.cancels == []
    state = await market.state()
    assert (state.payment, state.request, state.quotes) == (
        PaymentStatus.REQUIRES_PAYMENT,
        RequestStatus.CANCELLED,
        STILL_ACCEPTED,
    )
    assert summary(caplog) == counts(skipped=1)


@pytest.mark.parametrize("with_intent", [True, False])
@pytest.mark.parametrize("age", [timedelta(0), WINDOW - timedelta(minutes=5)])
async def test_payments_inside_the_window_are_untouched(
    market: Market, with_intent: bool, age: timedelta, caplog: pytest.LogCaptureFixture
) -> None:
    await set_payment(
        market,
        created_at=aged(age),
        stripe_payment_intent_id=market.intent_id if with_intent else None,
    )
    stripe = FakeStripePayments()
    caplog.set_level(logging.INFO)

    await sweep(market, stripe)

    assert stripe.cancels == []
    state = await market.state()
    assert (state.payment, state.request, state.quotes) == (
        PaymentStatus.REQUIRES_PAYMENT,
        RequestStatus.ACCEPTED,
        STILL_ACCEPTED,
    )
    assert summary(caplog) == counts()


async def test_stripe_unexpected_state_changes_nothing(
    market: Market, caplog: pytest.LogCaptureFixture
) -> None:
    """Stripe refuses the cancel (the customer paid meanwhile: processing or succeeded): no
    change, a debug line, and the intent's own event settles the payment."""
    await set_payment(market, created_at=aged())
    stripe = FakeStripePayments(cancel_refused=True)
    caplog.set_level(logging.DEBUG)

    await sweep(market, stripe)

    assert stripe.cancels == [
        (market.intent_id, await cancel_key(market.sessions, market.payment_id))
    ]
    state = await market.state()
    assert (state.payment, state.request, state.quotes) == (
        PaymentStatus.REQUIRES_PAYMENT,
        RequestStatus.ACCEPTED,
        STILL_ACCEPTED,
    )
    [refused] = records(caplog, "payment_unpaid_not_cancelable")
    assert refused.levelno == logging.DEBUG
    assert not [record for record in caplog.records if record.levelno >= logging.WARNING]
    assert summary(caplog) == counts(skipped=1)

    assert await market.deliver(SUCCEEDED) == "processed"
    state = await market.state()
    assert (state.payment, len(state.jobs)) == (PaymentStatus.SUCCEEDED, 1)


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (StripeUnavailableError(request_id="req_fixture_down"), None),
        (
            StripeRejectedError(request_id="req_fixture_gone", code="resource_missing"),
            "resource_missing",
        ),
    ],
)
async def test_stripe_unavailable_is_retried_next_run(
    market: Market, error: Exception, code: str | None, caplog: pytest.LogCaptureFixture
) -> None:
    """Stripe down (or refusing otherwise): logged with the error class and code, nothing
    changes, and the next run sends the same cancel."""
    await set_payment(market, created_at=aged())
    stripe = FakeStripePayments(errors={"cancel_payment_intent": error})
    caplog.set_level(logging.INFO)

    await sweep(market, stripe)

    assert stripe.cancels == []
    [failure] = records(caplog, "payment_unpaid_cancel_failed")
    assert failure.levelno == logging.ERROR
    assert extra_of(failure) == {
        "payment_id": str(market.payment_id),
        "quote_id": str(market.accepted_quote),
        "service_request_id": str(market.request_id),
        "error": type(error).__name__,
        "stripe_code": code,
    }
    assert summary(caplog) == counts(failed=1)
    assert (await market.state()).payment is PaymentStatus.REQUIRES_PAYMENT

    stripe.errors.clear()
    await sweep(market, stripe)

    assert stripe.cancels == [
        (market.intent_id, await cancel_key(market.sessions, market.payment_id))
    ]
    assert summary(caplog) == counts(canceled_remote=1)


async def test_a_refused_cancel_is_sent_again_under_a_new_key_once_the_payment_changes(
    market: Market, caplog: pytest.LogCaptureFixture
) -> None:
    """Stripe keeps a refusal (the intent was processing) under its key for 24 h: once the charge
    fails and the payment changes, the next run's cancel carries a key of its own."""
    await set_payment(market, created_at=aged())
    stripe = FakeStripePayments(cancel_refused=True)
    await sweep(market, stripe)
    refused = await cancel_key(market.sessions, market.payment_id)

    await set_payment(market, status=PaymentStatus.FAILED)
    stripe.cancel_refused = False
    caplog.set_level(logging.INFO)
    await sweep(market, stripe)

    retried = await cancel_key(market.sessions, market.payment_id)
    assert retried != refused
    assert stripe.cancels == [(market.intent_id, refused), (market.intent_id, retried)]
    assert summary(caplog) == counts(canceled_remote=1)


async def test_cron_is_idempotent(market: Market, caplog: pytest.LogCaptureFixture) -> None:
    """Two runs before Stripe's event send the same cancel with the same key (Stripe replays
    it); after the event the payment is canceled and never selected again."""
    await set_payment(market, created_at=aged())
    stripe = FakeStripePayments()
    caplog.set_level(logging.INFO)

    await sweep(market, stripe)
    await sweep(market, stripe)

    key = await cancel_key(market.sessions, market.payment_id)
    assert stripe.cancels == [(market.intent_id, key)] * 2
    assert (await market.state()).payment is PaymentStatus.REQUIRES_PAYMENT

    assert await market.deliver(CANCELED) == "processed"
    await sweep(market, stripe)

    assert len(stripe.cancels) == 2
    assert summary(caplog) == counts()
    state = await market.state()
    assert (state.payment, state.request, state.quotes) == (
        PaymentStatus.CANCELED,
        RequestStatus.QUOTE_READY,
        ALL_PENDING,
    )


async def test_local_cancel_happens_once(market: Market, caplog: pytest.LogCaptureFixture) -> None:
    await set_payment(market, stripe_payment_intent_id=None, created_at=aged())
    stripe = FakeStripePayments()
    caplog.set_level(logging.INFO)

    await sweep(market, stripe)
    await sweep(market, stripe)

    assert summary(caplog) == counts()
    assert len(records(caplog, "payment_canceled_quote_reopened")) == 1
    assert [extra_of(r)["to_status"] for r in records(caplog, "payment_status_changed")] == [
        "canceled"
    ]
    assert stripe.cancels == []


async def test_one_failing_payment_does_not_stop_the_batch(
    market: Market,
    committed: Committed,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """One payment's transaction fails (logged by class, never its text); the next one is still
    canceled, in batches of one here, so the run also reads past the first batch."""
    await set_payment(market, created_at=aged())
    other_intent = f"pi_test_other{uuid.uuid4().hex[:8]}"
    other = await add_payment(committed, intent_id=other_intent, created_at=aged())
    original = PaymentReconciler.close_unpaid

    async def failing(
        self: PaymentReconciler, payment_id: uuid.UUID, created_before: datetime
    ) -> UnpaidCheck:
        if payment_id == market.payment_id:
            raise RuntimeError("SELECT 'a literal that must not be logged'")
        return await original(self, payment_id, created_before)

    monkeypatch.setattr(PaymentReconciler, "close_unpaid", failing)
    monkeypatch.setattr(tasks, "UNPAID_BATCH", 1)
    stripe = FakeStripePayments()
    caplog.set_level(logging.INFO)

    await sweep(market, stripe)

    assert stripe.cancels == [(other_intent, await cancel_key(committed.sessions, other))]
    [failure] = records(caplog, "payment_unpaid_cancel_failed")
    assert extra_of(failure) == {"payment_id": str(market.payment_id), "error": "RuntimeError"}
    assert "a literal" not in caplog.text
    assert summary(caplog) == counts(canceled_remote=1, failed=1)
    assert (await market.state()).payment is PaymentStatus.REQUIRES_PAYMENT


async def test_concurrent_payment_sheet_and_local_cancel(
    committed: Committed, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The sweep locks first and cancels a payment that never had an intent; a payment call
    waiting on the request's lock then finds the request reopened: 409, and no PaymentIntent."""
    payment_id = await add_payment(committed, intent_id=None, created_at=aged())
    stripe = FakeStripePayments()
    locked = asyncio.Event()
    original = PaymentReconciler.close_unpaid

    async def hold_until_the_sheet_waits(
        self: PaymentReconciler, payment_id: uuid.UUID, created_before: datetime
    ) -> UnpaidCheck:
        check = await original(self, payment_id, created_before)
        locked.set()
        await wait_until_any_waits_on(committed.sessions, await backend_pid(self._session))
        return check

    monkeypatch.setattr(PaymentReconciler, "close_unpaid", hold_until_the_sheet_waits)
    try:
        async with asyncio.timeout(2 * LOCK_WAIT_DEADLINE_SECONDS):
            swept = asyncio.create_task(
                cancel_unpaid_payments(context(committed.sessions, settings, stripe))
            )
            await locked.wait()
            async with committed.sessions() as session:
                with pytest.raises(PaymentNotAvailableError) as refused:
                    await PaymentService(session, stripe, CONFIG).payment_sheet(
                        committed.customer, committed.request_id, committed.quote_id
                    )
            await swept
    except TimeoutError:
        pytest.fail("the sweep or the payment call never finished")

    assert refused.value.status_code == 409
    assert (stripe.intent_calls, stripe.customer_calls, stripe.cancels) == ([], [], [])
    assert (await committed_payment(committed, payment_id)).status is PaymentStatus.CANCELED
    assert await committed_statuses(committed) == (RequestStatus.QUOTE_READY, QuoteStatus.PENDING)


async def test_concurrent_payment_sheet_wins_and_the_intent_is_canceled_in_stripe(
    committed: Committed, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    """The payment call holds the payment's lock while it creates the PaymentIntent; the sweep
    waits on it, then finds the stored intent: it cancels it in Stripe, never locally."""
    payment_id = await add_payment(committed, intent_id=None, created_at=aged())
    stripe = FakeStripePayments()
    swept: list[asyncio.Task[None]] = []

    async with committed.sessions() as session:

        async def start_the_sweep_and_wait() -> None:
            swept.append(
                asyncio.create_task(
                    cancel_unpaid_payments(context(committed.sessions, settings, stripe))
                )
            )
            await wait_until_any_waits_on(committed.sessions, await backend_pid(session))

        stripe.on_create_intent = start_the_sweep_and_wait
        caplog.set_level(logging.INFO)
        try:
            async with asyncio.timeout(2 * LOCK_WAIT_DEADLINE_SECONDS):
                sheet = await PaymentService(session, stripe, CONFIG).payment_sheet(
                    committed.customer, committed.request_id, committed.quote_id
                )
                [task] = swept
                await task
        except TimeoutError:
            pytest.fail("the sweep or the payment call never finished")

    assert isinstance(sheet, PaymentSheetOut)
    [intent_id] = stripe.intents
    assert stripe.cancels == [(intent_id, await cancel_key(committed.sessions, payment_id))]
    payment = await committed_payment(committed, payment_id)
    assert (payment.status, payment.stripe_payment_intent_id) == (
        PaymentStatus.REQUIRES_PAYMENT,
        intent_id,
    )
    assert summary(caplog) == counts(canceled_remote=1)


async def test_sweep_logs_carry_ids_and_counts_only(
    market: Market, committed: Committed, caplog: pytest.LogCaptureFixture
) -> None:
    """Every line of the sweep, at DEBUG: ids, counts, outcomes and Stripe codes; never a
    PaymentIntent id, an amount or customer data."""
    await set_payment(market, created_at=aged())
    local = await add_payment(committed, intent_id=None, created_at=aged())
    stripe = FakeStripePayments()
    caplog.set_level(logging.DEBUG)

    await sweep(market, stripe)  # market: canceled in Stripe; committed: canceled locally
    stripe.cancel_refused = True
    await sweep(market, stripe)  # refused: not cancelable
    stripe.errors["cancel_payment_intent"] = StripeRejectedError(
        request_id="req_fixture", code="resource_missing"
    )
    await sweep(market, stripe)  # failed

    assert (await committed_payment(committed, local)).status is PaymentStatus.CANCELED
    formatter = JsonFormatter()
    lines = [
        formatter.format(record)
        for record in caplog.records
        if record.name.startswith("app.modules.payments")
    ]
    messages = {json.loads(line)["message"] for line in lines}
    assert {
        "unpaid_payments_swept",
        "payment_unpaid_cancel_requested",
        "payment_unpaid_not_cancelable",
        "payment_unpaid_cancel_failed",
        "payment_status_changed",
        "payment_canceled_quote_reopened",
    } <= messages
    text = "\n".join(lines)
    for secret in (market.intent_id, market.stripe_customer_id, market.customer_email):
        assert secret not in text
    assert committed.customer.email not in text
    for line in lines:
        values = list(json.loads(line).values())
        assert AMOUNT_CENTS not in values
        assert str(AMOUNT_CENTS) not in values
    for record in records(caplog, "unpaid_payments_swept"):
        assert set(extra_of(record)) == set(COUNTS)
