"""payment_intent.* webhooks (D11.3, #61; D11.5 tests): signed events through
POST /v1/webhooks/stripe, then the real process_stripe_event task, on real commits.

Each test builds its own market (a customer with a Stripe Customer, an accepted request, the
accepted quote of pro A, the pending quotes of pros B and C, and the payment of quote A with its
PaymentIntent) and deletes it afterwards. Signatures are HMAC-SHA256 with a fixture secret; no
network.
"""

import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from arq import Retry
from fastapi import FastAPI
from sqlalchemy import URL, delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from starlette.requests import Request

from app.config import Settings
from app.integrations.stripe_payments import get_stripe_payments
from app.modules.addresses.models import Address
from app.modules.categories.models import Category
from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.payments.models import Payment, PaymentStatus
from app.modules.pros.models import ProProfile, ProVerificationStatus
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.modules.webhooks.models import WebhookEvent, WebhookEventStatus
from app.modules.webhooks.service import process_job_id
from app.modules.webhooks.tasks import process_stripe_event
from app.money import split_amount
from app.observability import JsonFormatter
from app.queue import JobQueue, get_job_queue
from tests.conftest import make_settings
from tests.helpers import as_status_writer
from tests.test_payments_api import PUBLISHABLE_KEY, FakeStripePayments, _fake_stripe
from tests.test_quote_list_api import headers_for
from tests.test_stripe_webhooks_api import sign

# Fixture value, not a real secret.
SECRET = "whsec_test_fixture_value_not_real"
AMOUNT_CENTS = 10_005
TAKE_RATE_BPS = 1500
MAX_ATTEMPTS = 3
SUCCEEDED = "payment_intent.succeeded"
PROCESSING = "payment_intent.processing"
FAILED = "payment_intent.payment_failed"
CANCELED = "payment_intent.canceled"
# What Stripe puts next to a decline code; it must never reach a log.
DECLINE_MESSAGE = "Your card was declined."
# body(customer=...) default: the customer's stored Stripe Customer.
STORED_CUSTOMER = "<stored>"


@dataclass
class RecordingQueue:
    """ARQ's enqueue_job, recorded: a known job id is not queued again."""

    jobs: dict[str, tuple[str, tuple[object, ...]]] = field(default_factory=dict)

    async def enqueue_job(self, function: str, *args: object, _job_id: str | None = None) -> object:
        if _job_id is not None and _job_id in self.jobs:
            return None
        self.jobs[_job_id or uuid.uuid4().hex] = (function, args)
        return object()


def _queue(request: Request) -> JobQueue:
    """One override for every test (a closure per test would be kept by FastAPI's cache, #196)."""
    queue: JobQueue = request.app.state.payment_webhook_queue
    return queue


@dataclass
class Market:
    client: httpx.AsyncClient
    sessions: async_sessionmaker[AsyncSession]
    queue: RecordingQueue
    settings: Settings
    customer_id: uuid.UUID
    customer_email: str
    stripe_customer_id: str
    request_id: uuid.UUID
    # Pro A's (accepted, paid by the payment), then B's and C's (pending).
    quote_ids: list[uuid.UUID]
    pro_ids: list[uuid.UUID]
    payment_id: uuid.UUID
    intent_id: str
    event_ids: list[str] = field(default_factory=list)

    @property
    def accepted_quote(self) -> uuid.UUID:
        return self.quote_ids[0]

    def body(
        self,
        event_id: str,
        event_type: str,
        *,
        amount: int = AMOUNT_CENTS,
        currency: str = "usd",
        customer: str | None = STORED_CUSTOMER,
        intent_id: str | None = None,
        failure_code: str | None = None,
    ) -> bytes:
        intent = {
            "id": intent_id or self.intent_id,
            "object": "payment_intent",
            "amount": amount,
            "currency": currency,
            "customer": self.stripe_customer_id if customer == STORED_CUSTOMER else customer,
            "status": "requires_payment_method",
            "metadata": {
                "payment_id": str(self.payment_id),
                "quote_id": str(self.accepted_quote),
                "request_id": str(self.request_id),
            },
            "last_payment_error": (
                None
                if failure_code is None
                else {"code": failure_code, "message": DECLINE_MESSAGE, "type": "card_error"}
            ),
        }
        event = {
            "id": event_id,
            "object": "event",
            "type": event_type,
            "livemode": False,
            "created": int(time.time()),
            "api_version": "2026-10-28",
            "data": {"object": intent},
        }
        return json.dumps(event).encode()

    def new_event_id(self) -> str:
        event_id = f"evt_test_{uuid.uuid4().hex}"
        self.event_ids.append(event_id)
        return event_id

    async def post(self, body: bytes) -> None:
        response = await self.client.post(
            "/v1/webhooks/stripe",
            content=body,
            headers={"Content-Type": "application/json", "Stripe-Signature": sign(body, SECRET)},
        )
        assert response.status_code == 200, response.text

    async def process(self, event_id: str, *, job_try: int = 1) -> str:
        """Runs the task the receipt queued for the event, as the worker would."""
        _, args = self.queue.jobs[process_job_id(event_id)]
        context: dict[str, Any] = {
            "settings": self.settings,
            "session_factory": self.sessions,
            "job_try": job_try,
        }
        return await process_stripe_event(context, str(args[0]))

    async def deliver(self, event_type: str, *, event_id: str | None = None, **body: Any) -> str:
        """Posts a signed event and processes it; returns the task's outcome."""
        event_id = event_id or self.new_event_id()
        await self.post(self.body(event_id, event_type, **body))
        return await self.process(event_id)

    async def event_row(self, event_id: str) -> WebhookEvent:
        async with self.sessions() as session:
            row = await session.scalar(
                select(WebhookEvent).where(WebhookEvent.stripe_event_id == event_id)
            )
        assert row is not None
        return row

    async def state(self) -> "State":
        async with self.sessions() as session:
            payment = await session.scalar(
                select(Payment.status).where(Payment.id == self.payment_id)
            )
            request = await session.scalar(
                select(ServiceRequest.status).where(ServiceRequest.id == self.request_id)
            )
            quotes = {
                row.id: row.status
                for row in await session.execute(
                    select(Quote.id, Quote.status).where(Quote.request_id == self.request_id)
                )
            }
            jobs = list(
                (await session.scalars(select(Job).where(Job.request_id == self.request_id))).all()
            )
            events = list(
                (
                    await session.scalars(
                        select(JobEvent).where(JobEvent.job_id.in_([job.id for job in jobs]))
                    )
                ).all()
            )
        assert payment is not None
        assert request is not None
        return State(
            payment, request, [quotes[quote_id] for quote_id in self.quote_ids], jobs, events
        )


@dataclass(frozen=True)
class State:
    payment: PaymentStatus
    request: RequestStatus
    quotes: list[QuoteStatus]
    jobs: list[Job]
    job_events: list[JobEvent]


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        stripe_webhook_secret=SECRET,
        stripe_webhook_max_attempts=MAX_ATTEMPTS,
        stripe_publishable_key=PUBLISHABLE_KEY,
    )


@pytest.fixture
async def market(app: FastAPI, settings: Settings, test_database_url: URL) -> AsyncIterator[Market]:
    engine = create_async_engine(test_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    app.state.session_factory = sessions
    queue = RecordingQueue()
    app.state.payment_webhook_queue = queue
    app.dependency_overrides[get_job_queue] = _queue
    tag = uuid.uuid4().hex[:8]
    now = datetime.now(UTC)
    async with sessions() as session:
        customer = User(
            email=f"c-{tag}@x.com",
            password_hash="x",
            role=UserRole.CUSTOMER,
            stripe_customer_id=f"cus_test{tag}",
        )
        pro_users = [
            User(email=f"p{n}-{tag}@x.com", password_hash="x", role=UserRole.PRO) for n in range(3)
        ]
        category = Category(slug=f"test-{tag}", names={"en": "Test", "es": "Prueba"})
        session.add_all([customer, *pro_users, category])
        await session.flush()
        profiles = [
            ProProfile(
                user_id=user.id,
                verification_status=ProVerificationStatus.APPROVED,
                payouts_enabled=True,
            )
            for user in pro_users
        ]
        address = Address(
            user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
        )
        session.add_all([*profiles, address])
        await session.flush()
        request = ServiceRequest(
            customer_id=customer.id,
            address_id=address.id,
            category_id=category.id,
            description="Fix a leak",
            origin=RequestOrigin.APP,
            status=RequestStatus.ACCEPTED,
        )
        async with as_status_writer(session):  # the database guard (#163)
            session.add(request)
            await session.flush()
        quotes = [
            Quote(
                request_id=request.id,
                pro_id=profile.id,
                amount_cents=AMOUNT_CENTS + 100 * n,
                scope="Replace the valve",
                duration_minutes=60,
                proposed_start_at=now + timedelta(days=2),
                expires_at=now + timedelta(hours=24),
                status=QuoteStatus.ACCEPTED if n == 0 else QuoteStatus.PENDING,
            )
            for n, profile in enumerate(profiles)
        ]
        session.add_all(quotes)
        await session.flush()
        split = split_amount(AMOUNT_CENTS, TAKE_RATE_BPS)
        intent_id = f"pi_test{tag}"
        payment = Payment(
            request_id=request.id,
            quote_id=quotes[0].id,
            customer_id=customer.id,
            amount_cents=AMOUNT_CENTS,
            tax_cents=0,
            customer_total_cents=AMOUNT_CENTS,
            platform_fee_cents=split.platform_fee_cents,
            pro_payout_cents=split.pro_payout_cents,
            take_rate_bps=TAKE_RATE_BPS,
            currency="usd",
            status=PaymentStatus.REQUIRES_PAYMENT,
            stripe_payment_intent_id=intent_id,
        )
        session.add(payment)
        await session.commit()
    event_ids: list[str] = []
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            yield Market(
                client=client,
                sessions=sessions,
                queue=queue,
                settings=settings,
                customer_id=customer.id,
                customer_email=customer.email,
                stripe_customer_id=f"cus_test{tag}",
                request_id=request.id,
                quote_ids=[quote.id for quote in quotes],
                pro_ids=[profile.id for profile in profiles],
                payment_id=payment.id,
                intent_id=intent_id,
                event_ids=event_ids,
            )
    finally:
        app.dependency_overrides.pop(get_job_queue, None)
        async with sessions() as session:
            job_ids = select(Job.id).where(Job.request_id == request.id).scalar_subquery()
            await session.execute(delete(JobEvent).where(JobEvent.job_id.in_(job_ids)))
            await session.execute(delete(Job).where(Job.request_id == request.id))
            await session.execute(delete(Payment).where(Payment.request_id == request.id))
            await session.execute(delete(Quote).where(Quote.request_id == request.id))
            await session.execute(delete(ServiceRequest).where(ServiceRequest.id == request.id))
            await session.execute(delete(Address).where(Address.id == address.id))
            await session.execute(
                delete(ProProfile).where(ProProfile.id.in_([p.id for p in profiles]))
            )
            await session.execute(
                delete(User).where(User.id.in_([customer.id, *[u.id for u in pro_users]]))
            )
            await session.execute(delete(Category).where(Category.id == category.id))
            await session.execute(
                delete(WebhookEvent).where(WebhookEvent.stripe_event_id.in_(event_ids))
            )
            await session.commit()
        await engine.dispose()


def records(caplog: pytest.LogCaptureFixture, message: str) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.message == message]


async def test_succeeded_creates_one_scheduled_job_with_frozen_amounts(market: Market) -> None:
    event_id = market.new_event_id()

    await market.post(market.body(event_id, SUCCEEDED))
    assert await market.process(event_id) == "processed"

    state = await market.state()
    assert state.payment is PaymentStatus.SUCCEEDED
    assert state.request is RequestStatus.ACCEPTED
    [job] = state.jobs
    split = split_amount(AMOUNT_CENTS, TAKE_RATE_BPS)
    assert job.status is JobStatus.SCHEDULED
    assert (job.quote_id, job.customer_id, job.pro_id) == (
        market.accepted_quote,
        market.customer_id,
        market.pro_ids[0],
    )
    assert (
        job.customer_price_cents,
        job.pro_payout_cents,
        job.platform_fee_cents,
        job.tax_cents,
    ) == (AMOUNT_CENTS, split.pro_payout_cents, split.platform_fee_cents, 0)
    [created] = state.job_events
    assert (created.type, created.from_status, created.to_status, created.actor_id) == (
        "created",
        None,
        JobStatus.SCHEDULED,
        None,
    )
    row = await market.event_row(event_id)
    assert (row.status, row.attempts, row.payload) == (WebhookEventStatus.PROCESSED, 1, None)


async def test_succeeded_rejects_the_other_pending_quotes(market: Market) -> None:
    async with market.sessions() as session:
        # An expired and a withdrawn quote stay as they are; only pending ones are rejected.
        await session.execute(
            update(Quote).where(Quote.id == market.quote_ids[2]).values(status=QuoteStatus.EXPIRED)
        )
        await session.commit()

    assert await market.deliver(SUCCEEDED) == "processed"

    state = await market.state()
    assert state.quotes == [QuoteStatus.ACCEPTED, QuoteStatus.REJECTED, QuoteStatus.EXPIRED]


async def test_duplicate_succeeded_event_creates_no_second_job(market: Market) -> None:
    event_id = market.new_event_id()
    body = market.body(event_id, SUCCEEDED)
    await market.post(body)
    assert await market.process(event_id) == "processed"

    # The same event again: the row is processed, so nothing is queued or run.
    queued = dict(market.queue.jobs)
    await market.post(body)
    assert market.queue.jobs == queued
    assert await market.process(event_id) == "skipped"
    # Another event for the same PaymentIntent: the payment is succeeded already.
    assert await market.deliver(SUCCEEDED) == "processed"

    state = await market.state()
    assert len(state.jobs) == 1
    assert len(state.job_events) == 1
    assert state.payment is PaymentStatus.SUCCEEDED


@pytest.mark.parametrize("request_status", [RequestStatus.CANCELLED, RequestStatus.QUOTE_READY])
async def test_succeeded_after_request_cancelled_creates_no_job_and_flags_staff(
    market: Market, request_status: RequestStatus, caplog: pytest.LogCaptureFixture
) -> None:
    """Cancelled by the customer before the money arrived, or the request no longer waits on
    this quote: the payment still succeeds (the money was taken), no job, staff flagged."""
    async with market.sessions() as session:
        async with as_status_writer(session):
            await session.execute(
                update(ServiceRequest)
                .where(ServiceRequest.id == market.request_id)
                .values(status=request_status)
            )
        await session.commit()
    caplog.set_level(logging.INFO)

    assert await market.deliver(SUCCEEDED) == "processed"
    assert await market.deliver(SUCCEEDED) == "processed"  # never a second job, nor a second flag

    state = await market.state()
    assert state.payment is PaymentStatus.SUCCEEDED
    assert state.jobs == []
    assert state.quotes == [QuoteStatus.ACCEPTED, QuoteStatus.PENDING, QuoteStatus.PENDING]
    [flag] = records(caplog, "payment_succeeded_without_job")
    assert flag.levelno == logging.ERROR
    assert flag.__dict__["payment_id"] == str(market.payment_id)
    assert flag.__dict__["request_status"] == str(request_status)


@pytest.mark.parametrize(
    ("override", "field_name"),
    [
        ({"amount": AMOUNT_CENTS - 1}, "amount"),
        ({"currency": "eur"}, "currency"),
        ({"customer": "cus_someone_else"}, "customer"),
        ({"customer": None}, "customer"),
    ],
    ids=["amount", "currency", "customer", "no_customer"],
)
@pytest.mark.parametrize("event_type", [SUCCEEDED, PROCESSING, FAILED, CANCELED])
async def test_amount_or_currency_mismatch_changes_nothing_and_fails_the_event(
    market: Market,
    override: dict[str, Any],
    field_name: str,
    event_type: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    before = await market.state()
    event_id = market.new_event_id()
    await market.post(market.body(event_id, event_type, **override))

    with pytest.raises(Retry):
        await market.process(event_id)
    assert await market.process(event_id, job_try=MAX_ATTEMPTS) == "failed"

    after = await market.state()
    assert (after.payment, after.request, after.quotes, after.jobs) == (
        before.payment,
        before.request,
        before.quotes,
        [],
    )
    row = await market.event_row(event_id)
    assert (row.status, row.last_error) == (WebhookEventStatus.FAILED, "PaymentEventMismatchError")
    mismatches = records(caplog, "payment_event_mismatch")
    assert len(mismatches) == 2
    assert all(record.levelno == logging.ERROR for record in mismatches)
    assert {record.__dict__["fields"] for record in mismatches} == {field_name}


async def test_unknown_intent_is_logged_and_ignored(
    market: Market, caplog: pytest.LogCaptureFixture
) -> None:
    before = await market.state()
    event_id = market.new_event_id()

    assert await market.deliver(SUCCEEDED, event_id=event_id, intent_id="pi_test_unknown") == (
        "processed"
    )

    assert await market.state() == before
    assert (await market.event_row(event_id)).status is WebhookEventStatus.PROCESSED
    [warning] = records(caplog, "payment_event_unknown_intent")
    assert warning.levelno == logging.WARNING
    assert (warning.__dict__["stripe_event_id"], warning.__dict__["event_type"]) == (
        event_id,
        SUCCEEDED,
    )
    assert "payment_id" not in warning.__dict__


async def test_processing_then_failed_then_retry_succeeds(
    market: Market, caplog: pytest.LogCaptureFixture
) -> None:
    assert await market.deliver(PROCESSING) == "processed"
    assert (await market.state()).payment is PaymentStatus.PROCESSING

    assert await market.deliver(FAILED, failure_code="card_declined") == "processed"
    state = await market.state()
    # The customer retries with the same PaymentIntent: nothing reopens.
    assert (state.payment, state.request, state.quotes[0], state.jobs) == (
        PaymentStatus.FAILED,
        RequestStatus.ACCEPTED,
        QuoteStatus.ACCEPTED,
        [],
    )
    [failure] = records(caplog, "payment_attempt_failed")
    assert failure.__dict__["stripe_code"] == "card_declined"

    assert await market.deliver(PROCESSING) == "processed"
    assert (await market.state()).payment is PaymentStatus.PROCESSING
    assert await market.deliver(SUCCEEDED) == "processed"
    state = await market.state()
    assert state.payment is PaymentStatus.SUCCEEDED
    assert len(state.jobs) == 1


async def test_failed_payment_can_succeed_without_processing(market: Market) -> None:
    """Cards go from a failed attempt straight to success: no processing event between."""
    assert await market.deliver(FAILED, failure_code="insufficient_funds") == "processed"
    assert await market.deliver(SUCCEEDED) == "processed"

    state = await market.state()
    assert state.payment is PaymentStatus.SUCCEEDED
    assert len(state.jobs) == 1


@pytest.mark.parametrize("late", [PROCESSING, FAILED, CANCELED, SUCCEEDED])
async def test_out_of_order_processing_after_succeeded_is_a_noop(market: Market, late: str) -> None:
    assert await market.deliver(SUCCEEDED) == "processed"
    before = await market.state()

    assert await market.deliver(late, failure_code="card_declined") == "processed"

    after = await market.state()
    assert after.payment is PaymentStatus.SUCCEEDED
    assert (after.request, after.quotes, len(after.jobs)) == (
        before.request,
        before.quotes,
        len(before.jobs),
    )


@pytest.mark.parametrize("late", [PROCESSING, FAILED, SUCCEEDED, CANCELED])
async def test_every_event_after_canceled_is_a_noop(market: Market, late: str) -> None:
    assert await market.deliver(CANCELED) == "processed"
    before = await market.state()

    assert await market.deliver(late) == "processed"

    assert await market.state() == before
    assert before.payment is PaymentStatus.CANCELED


async def test_failed_after_failed_keeps_failed(market: Market) -> None:
    assert await market.deliver(FAILED) == "processed"
    assert await market.deliver(FAILED) == "processed"

    assert (await market.state()).payment is PaymentStatus.FAILED


async def test_canceled_reopens_the_quote_and_request(market: Market) -> None:
    """Before its expires_at the quote is pending again, and the other pending quotes keep the
    request quote_ready."""
    assert await market.deliver(CANCELED) == "processed"

    state = await market.state()
    assert state.payment is PaymentStatus.CANCELED
    assert state.request is RequestStatus.QUOTE_READY
    assert state.quotes == [QuoteStatus.PENDING, QuoteStatus.PENDING, QuoteStatus.PENDING]
    assert state.jobs == []


@pytest.mark.parametrize("others", [QuoteStatus.EXPIRED, QuoteStatus.WITHDRAWN])
async def test_canceled_expired_quote_with_no_pending_left_backs_out_to_finding_pro(
    market: Market, others: QuoteStatus
) -> None:
    async with market.sessions() as session:
        await session.execute(
            update(Quote)
            .where(Quote.id == market.accepted_quote)
            .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await session.execute(
            update(Quote).where(Quote.id.in_(market.quote_ids[1:])).values(status=others)
        )
        await session.commit()

    assert await market.deliver(CANCELED) == "processed"

    state = await market.state()
    assert state.payment is PaymentStatus.CANCELED
    assert state.quotes == [QuoteStatus.EXPIRED, others, others]
    assert state.request is RequestStatus.FINDING_PRO


async def test_canceled_with_a_due_pending_quote_left_stays_quote_ready(market: Market) -> None:
    """A pending quote past its expires_at, not yet marked: the expiry sweep (#51) expires it
    and backs the request out, as it does for any quote_ready request."""
    async with market.sessions() as session:
        await session.execute(
            update(Quote)
            .where(Quote.id.in_(market.quote_ids[1:]))
            .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await session.commit()

    assert await market.deliver(CANCELED) == "processed"

    state = await market.state()
    assert state.request is RequestStatus.QUOTE_READY
    assert state.quotes == [QuoteStatus.PENDING, QuoteStatus.PENDING, QuoteStatus.PENDING]


async def test_canceled_after_request_cancelled_reopens_nothing(market: Market) -> None:
    async with market.sessions() as session:
        async with as_status_writer(session):
            await session.execute(
                update(ServiceRequest)
                .where(ServiceRequest.id == market.request_id)
                .values(status=RequestStatus.CANCELLED)
            )
        await session.commit()

    assert await market.deliver(CANCELED) == "processed"

    state = await market.state()
    assert (state.payment, state.request) == (PaymentStatus.CANCELED, RequestStatus.CANCELLED)
    assert state.quotes == [QuoteStatus.ACCEPTED, QuoteStatus.PENDING, QuoteStatus.PENDING]


async def test_after_cancel_another_quote_can_be_accepted(market: Market) -> None:
    other = market.quote_ids[1]
    path = f"/v1/requests/{market.request_id}/quotes/{other}/accept"
    customer = headers_for(market.customer_id, UserRole.CUSTOMER)
    # While the payment is open, another quote cannot be accepted.
    assert (await market.client.post(path, headers=customer)).status_code == 409

    assert await market.deliver(CANCELED) == "processed"
    response = await market.client.post(path, headers=customer)

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "accepted"
    state = await market.state()
    assert state.request is RequestStatus.ACCEPTED
    assert state.quotes == [QuoteStatus.PENDING, QuoteStatus.ACCEPTED, QuoteStatus.PENDING]


async def test_the_same_quote_accepted_again_after_a_cancel_gets_a_fresh_payment(
    app: FastAPI, market: Market
) -> None:
    """#58 round 1 B4 end to end: the cancel reopens quote A, the customer accepts it again and
    pays: a new payment row with its own PaymentIntent (the canceled one stays), and that
    intent's success creates the job from the new payment."""
    app.state.fake_stripe_payments = FakeStripePayments()
    app.dependency_overrides[get_stripe_payments] = _fake_stripe
    stripe: FakeStripePayments = app.state.fake_stripe_payments
    customer = headers_for(market.customer_id, UserRole.CUSTOMER)
    base = f"/v1/requests/{market.request_id}/quotes/{market.accepted_quote}"
    try:
        assert await market.deliver(CANCELED) == "processed"
        accepted = await market.client.post(f"{base}/accept", headers=customer)
        assert accepted.status_code == 200, accepted.text
        paid = await market.client.post(f"{base}/payment", headers=customer)
        assert paid.status_code == 200, paid.text
    finally:
        app.dependency_overrides.pop(get_stripe_payments, None)

    async with market.sessions() as session:
        rows = {
            row.id: row
            for row in await session.scalars(
                select(Payment).where(Payment.quote_id == market.accepted_quote)
            )
        }
    assert len(rows) == 2
    [new_id] = set(rows) - {market.payment_id}
    old, new = rows[market.payment_id], rows[new_id]
    assert (old.status, old.stripe_payment_intent_id) == (PaymentStatus.CANCELED, market.intent_id)
    [new_intent] = stripe.intents
    assert (new.status, new.stripe_payment_intent_id) == (
        PaymentStatus.REQUIRES_PAYMENT,
        new_intent,
    )
    assert stripe.intent_calls[0]["idempotency_key"] == f"payment_intent:{new_id}"
    assert paid.json()["payment_intent_client_secret"] == stripe.intents[new_intent].client_secret

    assert await market.deliver(SUCCEEDED, intent_id=new_intent) == "processed"

    state = await market.state()
    assert state.request is RequestStatus.ACCEPTED
    [job] = state.jobs
    assert job.quote_id == market.accepted_quote
    async with market.sessions() as session:
        statuses = {
            row.id: row.status
            for row in await session.execute(
                select(Payment.id, Payment.status).where(Payment.quote_id == market.accepted_quote)
            )
        }
    assert statuses == {market.payment_id: PaymentStatus.CANCELED, new_id: PaymentStatus.SUCCEEDED}


async def test_payment_webhook_logs_carry_ids_only(
    market: Market, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)

    await market.deliver(PROCESSING)
    await market.deliver(FAILED, failure_code="card_declined")
    await market.deliver(SUCCEEDED)
    await market.deliver(PROCESSING)
    await market.deliver(SUCCEEDED, intent_id="pi_test_unknown")
    event_id = market.new_event_id()
    await market.post(market.body(event_id, CANCELED, amount=AMOUNT_CENTS + 7))
    await market.process(event_id, job_try=MAX_ATTEMPTS)

    formatter = JsonFormatter()
    lines = [
        formatter.format(record)
        for record in caplog.records
        if record.name.startswith("app.modules.payments")
    ]
    messages = {json.loads(line)["message"] for line in lines}
    assert {
        "payment_status_changed",
        "payment_attempt_failed",
        "job_scheduled",
        "payment_event_ignored",
        "payment_event_unknown_intent",
        "payment_event_mismatch",
    } <= messages
    text = "\n".join(lines)
    for secret in (
        market.intent_id,
        "pi_test_unknown",
        market.stripe_customer_id,
        market.customer_email,
        DECLINE_MESSAGE,
    ):
        assert secret not in text
    # No amount in any field, compared by value: a digit run can occur inside a uuid.
    amounts = {AMOUNT_CENTS, AMOUNT_CENTS + 7}
    for line in lines:
        values = list(json.loads(line).values())
        assert not amounts & {value for value in values if isinstance(value, int)}
        assert not {str(amount) for amount in amounts} & {
            value for value in values if isinstance(value, str)
        }


async def test_customer_without_stored_stripe_customer_fails_the_event(
    market: Market, caplog: pytest.LogCaptureFixture
) -> None:
    """No Stripe Customer stored for the payment's customer: nothing can match the event's."""
    async with market.sessions() as session:
        await session.execute(
            update(User).where(User.id == market.customer_id).values(stripe_customer_id=None)
        )
        await session.commit()
    before = await market.state()
    event_id = market.new_event_id()
    await market.post(market.body(event_id, SUCCEEDED))

    assert await market.process(event_id, job_try=MAX_ATTEMPTS) == "failed"

    assert await market.state() == before
    [mismatch] = records(caplog, "payment_event_mismatch")
    assert mismatch.__dict__["fields"] == "customer"
