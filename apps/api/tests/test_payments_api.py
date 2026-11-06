"""POST /v1/requests/{request_id}/quotes/{quote_id}/payment: the customer pays the quote they
accepted (D11.1, #58). Never calls Stripe: a fake replaces the wrapper, except where the real
wrapper runs on a mock transport to prove what reaches Sentry."""

import json
import logging
import uuid
from collections import Counter
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from datetime import timedelta
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
import sentry_sdk
import stripe
from fastapi import FastAPI, Request
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db import get_session
from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_payments import (
    CreatedCustomer,
    FoundPaymentIntents,
    PaymentIntentFacts,
    PaymentIntentState,
    StripePayments,
    StripePaymentsClient,
    get_stripe_payments,
)
from app.modules.payments.models import Payment, PaymentStatus
from app.modules.payments.schemas import PaymentSheetOut
from app.modules.payments.service import PaymentsConfig
from app.modules.pros.models import ProProfile, ProVerificationStatus
from app.modules.quotes.models import QuoteStatus
from app.modules.requests.models import RequestStatus
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.money import split_amount
from app.observability import JsonFormatter
from tests.conftest import _rolled_back_session, make_app, make_settings
from tests.test_opportunities_api import EMAIL, NOT_FOUND, World, build_world, make_request
from tests.test_quote_accept_api import statuses
from tests.test_quote_list_api import (
    FORBIDDEN,
    INVALID_TOKEN,
    QuotingPro,
    add_quote,
    customer,
    headers_for,
    quoting_pro,
)
from tests.test_quotes_api import set_setting
from tests.test_requests_api import make_caller
from tests.test_sentry_scrubbing import TEST_DSN, MemoryTransport, _payloads, sentry_transport

__all__ = ["sentry_transport"]  # a fixture, used by name

# Fixture values only: a test-mode-shaped key that is not a key, and a take rate that is not
# the default, so the tests prove the rate comes from settings.
PUBLISHABLE_KEY = "pk_test_fixturePayments58"
SECRET_KEY = "sk_test_fixture-not-a-real-key"
TAKE_RATE = "platform_take_rate_bps"
TAKE_RATE_BPS = 1500
# Not the default either: the window comes from settings.
RECONCILE_AFTER = timedelta(hours=5)
CONFIG = PaymentsConfig(publishable_key=PUBLISHABLE_KEY, intent_reconcile_after=RECONCILE_AFTER)
SHEET_KEYS = {
    "payment_intent_client_secret",
    "customer_id",
    "ephemeral_key_secret",
    "publishable_key",
    "amount_cents",
    "tax_cents",
    "customer_total_cents",
    "currency",
}
# What only the pro or the platform may see: never in the customer's response or its schema.
SPLIT_WORDS = ("payout", "fee", "take_rate")
NOT_AVAILABLE = {
    "error": {"code": "payment_not_available", "message": "This quote cannot be paid right now."}
}
PRO_NOT_HIREABLE = {
    "error": {"code": "pro_not_hireable", "message": "This pro can no longer be hired."}
}
NOT_CONFIGURED = {
    "error": {"code": "not_configured", "message": "Payments are not configured yet."}
}
UNAVAILABLE = {
    "error": {
        "code": "payments_unavailable",
        "message": "Payments are unavailable right now. Try again later.",
    }
}
PROVIDER_ERROR = {
    "error": {
        "code": "payments_error",
        "message": "The payment provider could not complete the request.",
    }
}
# What every log record carries without an `extra`: the rest of a record is the event's own.
_RECORD_FIELDS = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}

# The real wrapper's answers in the Sentry test: ids and secrets that name nothing real.
REAL_CUSTOMER = "cus_sentry_fixture0123"
REAL_INTENT = "pi_sentry_fixture0123"
REAL_CLIENT_SECRET = f"{REAL_INTENT}_secret_sentryfixture"
REAL_EPHEMERAL_SECRET = "ek_test_sentry_fixture_secret"


@dataclass
class FakeStripePayments:
    """Records every call and answers as Stripe does: the same idempotency key gets the same
    object back (customers and PaymentIntents alike). `errors` makes one operation fail;
    `on_create_customer` and `on_create_intent` run inside those creates, before they answer;
    `lost_answers` makes that many creates make their PaymentIntent and then fail as a timeout
    would; `intent_status` is what Stripe reports for every PaymentIntent. `facts` is what Stripe
    shows of each intent (amount, currency, customer, metadata payment_id), which the search by
    payment id reads: clearing `intents_by_key` is Stripe forgetting the keys, the intents kept.
    `search_complete` False: the search has another page."""

    customers: dict[str, str] = field(default_factory=dict)  # idempotency key -> customer id
    customer_calls: list[dict[str, str]] = field(default_factory=list)
    intents: dict[str, PaymentIntentState] = field(default_factory=dict)  # by PaymentIntent id
    intents_by_key: dict[str, str] = field(default_factory=dict)
    intent_calls: list[dict[str, object]] = field(default_factory=list)
    retrieved: list[str] = field(default_factory=list)
    ephemeral_keys: list[str] = field(default_factory=list)  # the customer of each
    errors: dict[str, Exception] = field(default_factory=dict)
    on_create_customer: Callable[[], Awaitable[None]] | None = None
    on_create_intent: Callable[[], Awaitable[None]] | None = None
    lost_answers: int = 0
    intent_status: str = "requires_payment_method"
    facts: dict[str, PaymentIntentFacts] = field(default_factory=dict)  # by PaymentIntent id
    searches: list[uuid.UUID] = field(default_factory=list)
    search_complete: bool = True

    def add_intent(self, facts: PaymentIntentFacts) -> None:
        """An intent Stripe holds that no create of this run answered with."""
        self.facts[facts.payment_intent_id] = facts
        self.intents[facts.payment_intent_id] = PaymentIntentState(
            payment_intent_id=facts.payment_intent_id,
            client_secret=f"{facts.payment_intent_id}_secret_{uuid.uuid4().hex[:8]}",
            status=self.intent_status,
            request_id="req_fake_intent",
        )

    async def create_customer(self, *, user_id: str, idempotency_key: str) -> CreatedCustomer:
        if "create_customer" in self.errors:
            raise self.errors["create_customer"]
        self.customer_calls.append({"user_id": user_id, "idempotency_key": idempotency_key})
        if self.on_create_customer is not None:
            await self.on_create_customer()
        customer_id = self.customers.get(idempotency_key)
        if customer_id is None:
            customer_id = f"cus_fake{len(self.customers)}{uuid.uuid4().hex[:6]}"
            self.customers[idempotency_key] = customer_id
        return CreatedCustomer(customer_id=customer_id, request_id="req_fake_customer")

    async def create_payment_intent(
        self,
        *,
        amount_cents: int,
        currency: str,
        customer_id: str,
        transfer_group: str,
        metadata: dict[str, str] | Any,
        idempotency_key: str,
    ) -> PaymentIntentState:
        if "create_payment_intent" in self.errors:
            raise self.errors["create_payment_intent"]
        self.intent_calls.append(
            {
                "amount_cents": amount_cents,
                "currency": currency,
                "customer_id": customer_id,
                "transfer_group": transfer_group,
                "metadata": dict(metadata),
                "idempotency_key": idempotency_key,
            }
        )
        if self.on_create_intent is not None:
            await self.on_create_intent()
        intent_id = self.intents_by_key.get(idempotency_key)
        if intent_id is None:
            intent_id = f"pi_fake{len(self.intents)}{uuid.uuid4().hex[:6]}"
            self.intents_by_key[idempotency_key] = intent_id
            self.intents[intent_id] = PaymentIntentState(
                payment_intent_id=intent_id,
                client_secret=f"{intent_id}_secret_{uuid.uuid4().hex[:8]}",
                status=self.intent_status,
                request_id="req_fake_intent",
            )
            self.facts[intent_id] = PaymentIntentFacts(
                payment_intent_id=intent_id,
                amount_cents=amount_cents,
                currency=currency,
                customer_id=customer_id,
                payment_id=dict(metadata).get("payment_id"),
            )
        if self.lost_answers:
            self.lost_answers -= 1
            raise StripeUnavailableError(request_id="req_fake_lost")
        return self.intents[intent_id]

    async def retrieve_payment_intent(self, payment_intent_id: str) -> PaymentIntentState:
        if "retrieve_payment_intent" in self.errors:
            raise self.errors["retrieve_payment_intent"]
        self.retrieved.append(payment_intent_id)
        stored = self.intents[payment_intent_id]
        return PaymentIntentState(
            payment_intent_id=stored.payment_intent_id,
            client_secret=stored.client_secret,
            status=self.intent_status,
            request_id="req_fake_retrieve",
        )

    async def search_payment_intents(self, payment_id: uuid.UUID) -> FoundPaymentIntents:
        if "search_payment_intents" in self.errors:
            raise self.errors["search_payment_intents"]
        self.searches.append(payment_id)
        found = tuple(f for f in self.facts.values() if f.payment_id == str(payment_id))
        return FoundPaymentIntents(intents=found, complete=self.search_complete)

    async def payment_intent_facts(self, payment_intent_id: str) -> PaymentIntentFacts:
        if "payment_intent_facts" in self.errors:
            raise self.errors["payment_intent_facts"]
        facts = self.facts.get(payment_intent_id)
        if facts is None:
            raise StripeRejectedError(request_id="req_fake_missing", code="resource_missing")
        return facts

    async def create_ephemeral_key(self, customer_id: str) -> str:
        if "create_ephemeral_key" in self.errors:
            raise self.errors["create_ephemeral_key"]
        self.ephemeral_keys.append(customer_id)
        return f"ek_test_fake{len(self.ephemeral_keys)}_{uuid.uuid4().hex[:8]}"


def _fake_stripe(request: Request) -> StripePayments:
    """One override for every test (a closure per test would stay in FastAPI's caches, #196)."""
    fake: FakeStripePayments = request.app.state.fake_stripe_payments
    return fake


@pytest.fixture
def settings() -> Settings:
    # The secret key is passed as None so a STRIPE_SECRET_KEY in the shell never reaches the
    # app: without the fake, the real dependency finds no Stripe.
    return make_settings(
        stripe_secret_key=None,
        stripe_publishable_key=PUBLISHABLE_KEY,
        stripe_payment_intent_reconcile_after_seconds=int(RECONCILE_AFTER.total_seconds()),
    )


@pytest.fixture
def stripe_fake(app: FastAPI) -> FakeStripePayments:
    app.state.fake_stripe_payments = FakeStripePayments()
    app.dependency_overrides[get_stripe_payments] = _fake_stripe
    fake: FakeStripePayments = app.state.fake_stripe_payments
    return fake


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    return await build_world(db_session)


@pytest.fixture(autouse=True)
async def take_rate(db_session: AsyncSession) -> None:
    """The take rate, a fixture value, in the rolled-back test session."""
    await set_setting(db_session, TAKE_RATE, TAKE_RATE_BPS)


def payment_path(request_id: uuid.UUID, quote_id: uuid.UUID) -> str:
    return f"/v1/requests/{request_id}/quotes/{quote_id}/payment"


async def pay(
    client: httpx.AsyncClient,
    world: World,
    request_id: uuid.UUID,
    quote_id: uuid.UUID,
    **kwargs: Any,
) -> httpx.Response:
    return await client.post(payment_path(request_id, quote_id), headers=customer(world), **kwargs)


async def accepted_request(
    session: AsyncSession, world: World, *, amount: int = 10_000, pending: int = 1
) -> tuple[uuid.UUID, uuid.UUID, QuotingPro]:
    """An accepted request with its accepted quote from a hireable pro, plus `pending` pending
    quotes from other pros: (request id, accepted quote id, its pro)."""
    request_id = await make_request(session, world, RequestStatus.ACCEPTED)
    pro = await quoting_pro(session)
    quote_id = await add_quote(session, request_id, pro, amount=amount, status=QuoteStatus.ACCEPTED)
    for n in range(pending):
        await add_quote(session, request_id, await quoting_pro(session), amount=amount + 1 + n)
    return request_id, quote_id, pro


async def payments_of(session: AsyncSession, quote_id: uuid.UUID) -> list[Payment]:
    """The quote's payment rows as committed (not the identity map)."""
    statement = (
        select(Payment)
        .where(Payment.quote_id == quote_id)
        .execution_options(populate_existing=True)
    )
    return list((await session.scalars(statement)).all())


async def customer_id_of(session: AsyncSession, user_id: uuid.UUID) -> str | None:
    return await session.scalar(select(User.stripe_customer_id).where(User.id == user_id))


def events(caplog: pytest.LogCaptureFixture, message: str) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.message == message]


def extra_of(record: logging.LogRecord) -> dict[str, object]:
    return {key: value for key, value in record.__dict__.items() if key not in _RECORD_FIELDS}


def rendered(caplog: pytest.LogCaptureFixture) -> str:
    """Every captured record as the JSON line production would write."""
    formatter = JsonFormatter()
    return "\n".join(formatter.format(record) for record in caplog.records)


# Amounts


async def test_payment_amounts_come_from_the_quote_and_take_rate(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """15%, the fee rounded half up as split_amount does (10,005 * 15% = 1,500.75 -> 1,501),
    tax 0, the customer's total the amount plus the tax; the client sends no amount."""
    amount = 10_005
    request_id, quote_id, _ = await accepted_request(db_session, world, amount=amount)
    split = split_amount(amount, TAKE_RATE_BPS)
    assert (split.platform_fee_cents, split.pro_payout_cents) == (1_501, 8_504)

    with caplog.at_level(logging.INFO):
        response = await pay(db_client, world, request_id, quote_id)

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == SHEET_KEYS
    assert (body["amount_cents"], body["tax_cents"], body["customer_total_cents"]) == (
        amount,
        0,
        amount,
    )
    assert (body["currency"], body["publishable_key"]) == ("usd", PUBLISHABLE_KEY)
    [payment] = await payments_of(db_session, quote_id)
    assert (
        payment.amount_cents,
        payment.tax_cents,
        payment.customer_total_cents,
        payment.platform_fee_cents,
        payment.pro_payout_cents,
        payment.take_rate_bps,
        payment.currency,
        payment.status,
    ) == (amount, 0, amount, 1_501, 8_504, TAKE_RATE_BPS, "usd", PaymentStatus.REQUIRES_PAYMENT)
    assert (payment.request_id, payment.quote_id, payment.customer_id) == (
        request_id,
        quote_id,
        world.customer_id,
    )
    # Stripe was asked for the customer's total, read from the row.
    [call] = stripe_fake.intent_calls
    assert (call["amount_cents"], call["currency"]) == (amount, "usd")
    [created] = events(caplog, "payment_created")
    assert extra_of(created) == {
        "payment_id": str(payment.id),
        "quote_id": str(quote_id),
        "service_request_id": str(request_id),
        "user_id": str(world.customer_id),
    }


async def test_a_body_with_an_amount_is_422_and_creates_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
) -> None:
    request_id, quote_id, _ = await accepted_request(db_session, world)

    for body in ({"amount_cents": 1}, {"customer_total_cents": 1}, {"tax_cents": 0}):
        response = await pay(db_client, world, request_id, quote_id, json=body)
        assert response.status_code == 422, response.text
        assert response.json()["error"]["code"] == "validation_error"
    assert await payments_of(db_session, quote_id) == []
    assert (stripe_fake.customer_calls, stripe_fake.intent_calls) == ([], [])

    # No body, or an empty object, is the call.
    assert (await pay(db_client, world, request_id, quote_id)).status_code == 200
    assert (await pay(db_client, world, request_id, quote_id, json={})).status_code == 200


@pytest.mark.parametrize("take_rate", [0, 10_000, 2_000, "abc", 10_001])
async def test_take_rate_comes_from_settings(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
    take_rate: object,
) -> None:
    """Any valid rate is applied; a malformed one is 503 not_configured, never a fee of 0."""
    await set_setting(db_session, TAKE_RATE, take_rate)
    request_id, quote_id, _ = await accepted_request(db_session, world)

    response = await pay(db_client, world, request_id, quote_id)

    if isinstance(take_rate, int) and take_rate <= 10_000:
        assert response.status_code == 200, response.text
        [payment] = await payments_of(db_session, quote_id)
        split = split_amount(10_000, take_rate)
        assert (payment.platform_fee_cents, payment.pro_payout_cents, payment.take_rate_bps) == (
            split.platform_fee_cents,
            split.pro_payout_cents,
            take_rate,
        )
    else:
        assert response.status_code == 503, response.text
        assert response.json()["error"]["code"] == "not_configured"
        assert await payments_of(db_session, quote_id) == []
        assert stripe_fake.intent_calls == []


# Who, and which quote


async def test_payment_requires_the_accepted_quote(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
) -> None:
    request_id, accepted, _ = await accepted_request(db_session, world)
    [pending] = [q.id for q in await _quotes(db_session, request_id) if q.id != accepted]
    open_request = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    open_quote = await add_quote(db_session, open_request, await quoting_pro(db_session))
    _, other_accepted, _ = await accepted_request(db_session, world)
    stranger = await make_caller(db_session, UserRole.CUSTOMER)

    conflicts = [
        # A pending quote of the accepted request.
        await pay(db_client, world, request_id, pending),
        # A request still comparing quotes.
        await pay(db_client, world, open_request, open_quote),
    ]
    not_found = [
        # Someone else's accepted request, with its accepted quote.
        await db_client.post(payment_path(request_id, accepted), headers=stranger.headers),
        # The accepted quote of the customer's other request, under this one.
        await pay(db_client, world, request_id, other_accepted),
        await pay(db_client, world, request_id, uuid.uuid4()),
        await pay(db_client, world, uuid.uuid4(), accepted),
    ]

    assert [r.status_code for r in conflicts] == [409, 409]
    assert all(r.json() == NOT_AVAILABLE for r in conflicts)
    assert [r.status_code for r in not_found] == [404] * 4
    assert all(r.json() == NOT_FOUND for r in not_found)
    assert len({r.content for r in not_found}) == 1
    for quote_id in (pending, open_quote, other_accepted, accepted):
        assert await payments_of(db_session, quote_id) == []
    assert (stripe_fake.customer_calls, stripe_fake.intent_calls) == ([], [])
    assert await statuses(db_session, request_id) == (
        RequestStatus.ACCEPTED,
        {accepted: QuoteStatus.ACCEPTED, pending: QuoteStatus.PENDING},
    )


async def test_non_customers_are_refused(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
) -> None:
    request_id, quote_id, pro = await accepted_request(db_session, world)
    admin = await make_caller(db_session, UserRole.ADMIN)
    callers = [
        headers_for(pro.user_id, UserRole.PRO),  # even the pro whose quote it is
        headers_for(world.agent_id, UserRole.AGENT),
        admin.headers,
    ]

    for headers in callers:
        response = await db_client.post(payment_path(request_id, quote_id), headers=headers)
        assert (response.status_code, response.json()) == (403, FORBIDDEN)
    for headers in ({}, {"Authorization": "Bearer not-a-token"}):
        response = await db_client.post(payment_path(request_id, quote_id), headers=headers)
        assert (response.status_code, response.json()) == (401, INVALID_TOKEN)
    assert await payments_of(db_session, quote_id) == []
    assert stripe_fake.intent_calls == []


async def test_malformed_ids_422(db_client: httpx.AsyncClient, world: World) -> None:
    for url in (
        f"/v1/requests/not-a-uuid/quotes/{uuid.uuid4()}/payment",
        f"/v1/requests/{uuid.uuid4()}/quotes/not-a-uuid/payment",
    ):
        response = await db_client.post(url, headers=customer(world))
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"


@pytest.mark.parametrize(
    ("verification", "payouts_enabled"),
    [
        (ProVerificationStatus.PENDING, True),
        (ProVerificationStatus.REJECTED, True),
        (ProVerificationStatus.APPROVED, False),
    ],
)
async def test_payment_rechecks_the_pro(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
    caplog: pytest.LogCaptureFixture,
    verification: ProVerificationStatus,
    payouts_enabled: bool,
) -> None:
    """A pro who lost approval or payouts since the acceptance cannot be paid: 409, nothing
    created, a warning with ids. The quote stays accepted (#61 reconciles)."""
    request_id, quote_id, pro = await accepted_request(db_session, world)
    profile = await db_session.get(ProProfile, pro.profile_id)
    assert profile is not None
    profile.verification_status = verification
    profile.payouts_enabled = payouts_enabled
    await db_session.flush()

    with caplog.at_level(logging.INFO):
        response = await pay(db_client, world, request_id, quote_id)

    assert (response.status_code, response.json()) == (409, PRO_NOT_HIREABLE)
    assert await payments_of(db_session, quote_id) == []
    assert await customer_id_of(db_session, world.customer_id) is None
    assert (stripe_fake.customer_calls, stripe_fake.intent_calls) == ([], [])
    [warned] = events(caplog, "payment_pro_not_hireable")
    assert warned.levelno == logging.WARNING
    assert extra_of(warned) == {
        "quote_id": str(quote_id),
        "service_request_id": str(request_id),
        "pro_id": str(pro.profile_id),
        "user_id": str(world.customer_id),
    }
    assert pro.email not in rendered(caplog)
    assert (await statuses(db_session, request_id))[1][quote_id] is QuoteStatus.ACCEPTED


# Once per quote


async def test_payment_is_idempotent_per_quote(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A second call returns the same PaymentIntent, read back from Stripe by its stored id,
    with a new ephemeral key; one row, one customer, one create."""
    request_id, quote_id, _ = await accepted_request(db_session, world)

    with caplog.at_level(logging.INFO):
        first = await pay(db_client, world, request_id, quote_id)
        second = await pay(db_client, world, request_id, quote_id)

    assert (first.status_code, second.status_code) == (200, 200)
    one, two = first.json(), second.json()
    assert one["payment_intent_client_secret"] == two["payment_intent_client_secret"]
    assert one["customer_id"] == two["customer_id"]
    assert one["ephemeral_key_secret"] != two["ephemeral_key_secret"]
    assert {k: v for k, v in one.items() if k != "ephemeral_key_secret"} == {
        k: v for k, v in two.items() if k != "ephemeral_key_secret"
    }
    [payment] = await payments_of(db_session, quote_id)
    [intent_id] = stripe_fake.intents
    assert payment.stripe_payment_intent_id == intent_id
    assert len(stripe_fake.intent_calls) == 1
    assert stripe_fake.retrieved == [intent_id]
    assert len(stripe_fake.customer_calls) == 1
    assert stripe_fake.ephemeral_keys == [one["customer_id"]] * 2
    assert len(events(caplog, "payment_created")) == 1
    assert len(events(caplog, "payment_intent_created")) == 1
    assert len(events(caplog, "payment_sheet_issued")) == 2


async def test_lost_create_answer_retries_with_the_same_key(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
) -> None:
    """Stripe made the PaymentIntent, but its answer was lost: the row was committed before
    the call, so the retry sends the same key and Stripe replays the same intent."""
    request_id, quote_id, _ = await accepted_request(db_session, world)
    stripe_fake.lost_answers = 1

    lost = await pay(db_client, world, request_id, quote_id)
    [payment] = await payments_of(db_session, quote_id)
    assert (lost.status_code, lost.json()) == (503, UNAVAILABLE)
    assert payment.stripe_payment_intent_id is None
    assert payment.status is PaymentStatus.REQUIRES_PAYMENT

    retried = await pay(db_client, world, request_id, quote_id)

    assert retried.status_code == 200, retried.text
    first, second = stripe_fake.intent_calls
    assert first == second
    assert first["idempotency_key"] == f"payment_intent:{payment.id}"
    [intent_id] = stripe_fake.intents
    [payment] = await payments_of(db_session, quote_id)
    assert payment.stripe_payment_intent_id == intent_id
    assert retried.json()["payment_intent_client_secret"] == (
        stripe_fake.intents[intent_id].client_secret
    )
    assert stripe_fake.retrieved == []


async def test_customer_is_created_once_and_reused(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The first payment creates the customer's Stripe Customer with the user's key and
    metadata, no email; the customer's other request reuses it, and a stored id is never
    created again."""
    first_request, first_quote, _ = await accepted_request(db_session, world)
    second_request, second_quote, _ = await accepted_request(db_session, world)

    with caplog.at_level(logging.INFO):
        first = await pay(db_client, world, first_request, first_quote)
        second = await pay(db_client, world, second_request, second_quote)

    assert (first.status_code, second.status_code) == (200, 200)
    [call] = stripe_fake.customer_calls
    assert call == {
        "user_id": str(world.customer_id),
        "idempotency_key": f"customer:{world.customer_id}",
    }
    [customer_id] = stripe_fake.customers.values()
    assert await customer_id_of(db_session, world.customer_id) == customer_id
    assert first.json()["customer_id"] == second.json()["customer_id"] == customer_id
    assert {c["customer_id"] for c in stripe_fake.intent_calls} == {customer_id}
    [created] = events(caplog, "stripe_customer_created")
    assert extra_of(created)["user_id"] == str(world.customer_id)
    assert customer_id not in rendered(caplog)

    # A customer whose id was stored earlier (another device, a support fix): no create.
    stored = f"cus_stored{uuid.uuid4().hex[:8]}"
    await db_session.execute(
        update(User).where(User.id == world.customer_id).values(stripe_customer_id=stored)
    )
    third_request, third_quote, _ = await accepted_request(db_session, world)
    third = await pay(db_client, world, third_request, third_quote)
    assert third.status_code == 200
    assert third.json()["customer_id"] == stored
    assert len(stripe_fake.customer_calls) == 1
    assert stripe_fake.ephemeral_keys[-1] == stored


async def test_payment_intent_is_created_from_the_row_for_the_sheet(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
) -> None:
    """The ids #61 reads in the metadata, the transfer group of the request (#68), the
    customer and the deterministic key; the parameters Stripe receives are the wrapper's
    (test_stripe_payments.py::test_payment_intent_parameters)."""
    request_id, quote_id, _ = await accepted_request(db_session, world, amount=12_345)

    response = await pay(db_client, world, request_id, quote_id)

    assert response.status_code == 200, response.text
    [payment] = await payments_of(db_session, quote_id)
    [customer_id] = stripe_fake.customers.values()
    assert stripe_fake.intent_calls == [
        {
            "amount_cents": 12_345,
            "currency": "usd",
            "customer_id": customer_id,
            "transfer_group": f"request:{request_id}",
            "metadata": {
                "payment_id": str(payment.id),
                "quote_id": str(quote_id),
                "request_id": str(request_id),
            },
            "idempotency_key": f"payment_intent:{payment.id}",
        }
    ]
    assert response.json()["payment_intent_client_secret"].startswith(
        payment.stripe_payment_intent_id or "?"
    )


async def test_succeeded_payment_is_not_reopened(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
) -> None:
    """Once the webhook (#61) recorded the payment's success, no sheet is issued: the job
    exists or is being created. Nothing is written or asked of Stripe. The succeeded payment is
    checked before the pro: a pro unhireable since changes nothing."""
    status = PaymentStatus.SUCCEEDED
    request_id, quote_id, pro = await accepted_request(db_session, world)
    assert (await pay(db_client, world, request_id, quote_id)).status_code == 200
    [payment] = await payments_of(db_session, quote_id)
    await db_session.execute(update(Payment).where(Payment.id == payment.id).values(status=status))
    calls_before = (len(stripe_fake.intent_calls), len(stripe_fake.retrieved))

    response = await pay(db_client, world, request_id, quote_id)

    assert (response.status_code, response.json()) == (409, NOT_AVAILABLE)
    [same] = await payments_of(db_session, quote_id)
    assert (same.status, same.stripe_payment_intent_id) == (
        status,
        payment.stripe_payment_intent_id,
    )
    assert (len(stripe_fake.intent_calls), len(stripe_fake.retrieved)) == calls_before
    assert len(stripe_fake.ephemeral_keys) == 1

    profile = await db_session.get(ProProfile, pro.profile_id)
    assert profile is not None
    profile.payouts_enabled = False
    await db_session.flush()
    again = await pay(db_client, world, request_id, quote_id)
    assert (again.status_code, again.json()) == (409, NOT_AVAILABLE)


@pytest.mark.parametrize("status", [PaymentStatus.FAILED, PaymentStatus.PROCESSING])
async def test_failed_or_processing_payment_gets_the_same_sheet_again(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
    status: PaymentStatus,
) -> None:
    """A failed attempt may be retried on the same PaymentIntent; a processing one is shown as
    it is. Neither creates anything."""
    request_id, quote_id, _ = await accepted_request(db_session, world)
    first = await pay(db_client, world, request_id, quote_id)
    [payment] = await payments_of(db_session, quote_id)
    await db_session.execute(update(Payment).where(Payment.id == payment.id).values(status=status))

    second = await pay(db_client, world, request_id, quote_id)

    assert second.status_code == 200, second.text
    assert (
        second.json()["payment_intent_client_secret"]
        == first.json()["payment_intent_client_secret"]
    )
    assert len(stripe_fake.intent_calls) == 1
    assert stripe_fake.retrieved == [payment.stripe_payment_intent_id]


@pytest.mark.parametrize("intent_status", ["succeeded", "canceled"])
async def test_a_payment_intent_stripe_closed_is_409(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
    caplog: pytest.LogCaptureFixture,
    intent_status: str,
) -> None:
    """Stripe reports the PaymentIntent closed before the webhook landed: no sheet, a warning
    with ids; the row is left to #61."""
    request_id, quote_id, _ = await accepted_request(db_session, world)
    assert (await pay(db_client, world, request_id, quote_id)).status_code == 200
    stripe_fake.intent_status = intent_status

    with caplog.at_level(logging.INFO):
        response = await pay(db_client, world, request_id, quote_id)

    assert (response.status_code, response.json()) == (409, NOT_AVAILABLE)
    [payment] = await payments_of(db_session, quote_id)
    assert payment.status is PaymentStatus.REQUIRES_PAYMENT
    [warned] = events(caplog, "payment_intent_closed")
    assert extra_of(warned)["intent_status"] == intent_status
    assert extra_of(warned)["payment_id"] == str(payment.id)
    assert len(stripe_fake.ephemeral_keys) == 1


# Stripe failing


async def test_stripe_errors_map_to_503_and_502(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Unreachable, 409, 429 or 5xx: 503; any other 4xx: 502. Nothing stored changes, and the
    row stays for the retry."""
    request_id, quote_id, _ = await accepted_request(db_session, world)
    unavailable = StripeUnavailableError(request_id="req_fake_503", code=None)
    rejected = StripeRejectedError(request_id="req_fake_400", code="parameter_invalid_integer")

    with caplog.at_level(logging.INFO):
        # On the customer: the row exists, no customer stored.
        stripe_fake.errors = {"create_customer": unavailable}
        response = await pay(db_client, world, request_id, quote_id)
        assert (response.status_code, response.json()) == (503, UNAVAILABLE)
        [payment] = await payments_of(db_session, quote_id)
        assert payment.stripe_payment_intent_id is None
        assert await customer_id_of(db_session, world.customer_id) is None
        stripe_fake.errors = {"create_customer": rejected}
        response = await pay(db_client, world, request_id, quote_id)
        assert (response.status_code, response.json()) == (502, PROVIDER_ERROR)
        assert await customer_id_of(db_session, world.customer_id) is None

        # On the PaymentIntent create: the customer is stored, no intent id.
        stripe_fake.errors = {"create_payment_intent": unavailable}
        response = await pay(db_client, world, request_id, quote_id)
        assert (response.status_code, response.json()) == (503, UNAVAILABLE)
        [customer_id] = stripe_fake.customers.values()
        assert await customer_id_of(db_session, world.customer_id) == customer_id
        [payment] = await payments_of(db_session, quote_id)
        assert payment.stripe_payment_intent_id is None
        stripe_fake.errors = {"create_payment_intent": rejected}
        response = await pay(db_client, world, request_id, quote_id)
        assert (response.status_code, response.json()) == (502, PROVIDER_ERROR)
        [payment] = await payments_of(db_session, quote_id)
        assert payment.stripe_payment_intent_id is None

        # On the ephemeral key: the intent id is stored and kept.
        stripe_fake.errors = {"create_ephemeral_key": unavailable}
        response = await pay(db_client, world, request_id, quote_id)
        assert (response.status_code, response.json()) == (503, UNAVAILABLE)
        [payment] = await payments_of(db_session, quote_id)
        [intent_id] = stripe_fake.intents
        assert payment.stripe_payment_intent_id == intent_id
        stripe_fake.errors = {"create_ephemeral_key": rejected}
        response = await pay(db_client, world, request_id, quote_id)
        assert (response.status_code, response.json()) == (502, PROVIDER_ERROR)

        # On the retrieve: the same.
        stripe_fake.errors = {"retrieve_payment_intent": unavailable}
        assert (await pay(db_client, world, request_id, quote_id)).status_code == 503
        stripe_fake.errors = {"retrieve_payment_intent": rejected}
        assert (await pay(db_client, world, request_id, quote_id)).status_code == 502
        [payment] = await payments_of(db_session, quote_id)
        assert payment.stripe_payment_intent_id == intent_id

        # A working round, so success logs are checked too.
        stripe_fake.errors = {}
        response = await pay(db_client, world, request_id, quote_id)
        assert response.status_code == 200, response.text

    unavailable_logs = events(caplog, "payment_stripe_unavailable")
    rejected_logs = events(caplog, "payment_stripe_rejected")
    assert [extra_of(r)["operation"] for r in unavailable_logs] == [
        "create_customer",
        "create_payment_intent",
        "create_ephemeral_key",
        "retrieve_payment_intent",
    ]
    assert [extra_of(r)["operation"] for r in rejected_logs] == [
        "create_customer",
        "create_payment_intent",
        "create_ephemeral_key",
        "retrieve_payment_intent",
    ]
    for record in unavailable_logs + rejected_logs:
        extra = extra_of(record)
        assert extra["payment_id"] == str(payment.id)
        assert extra["stripe_request_id"] in ("req_fake_503", "req_fake_400")
    assert extra_of(rejected_logs[0])["stripe_code"] == "parameter_invalid_integer"
    wire = rendered(caplog)
    for leak in (customer_id, intent_id, response.json()["payment_intent_client_secret"]):
        assert leak not in wire
    assert len(await payments_of(db_session, quote_id)) == 1


async def test_not_configured_is_503(
    app: FastAPI, db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id, quote_id, _ = await accepted_request(db_session, world)

    # No override: the real dependency, and STRIPE_SECRET_KEY is unset.
    response = await pay(db_client, world, request_id, quote_id)
    assert (response.status_code, response.json()) == (503, NOT_CONFIGURED)

    # The secret key alone is not enough: the sheet needs the publishable key too.
    app.state.fake_stripe_payments = FakeStripePayments()
    app.dependency_overrides[get_stripe_payments] = _fake_stripe
    app.state.settings = make_settings(stripe_secret_key=None, stripe_publishable_key=None)
    response = await pay(db_client, world, request_id, quote_id)
    assert (response.status_code, response.json()) == (503, NOT_CONFIGURED)
    assert await payments_of(db_session, quote_id) == []
    assert app.state.fake_stripe_payments.customer_calls == []


@pytest.mark.parametrize(
    "key", ["sk_live_fixtureNotAKey", "rk_test_fixtureNotAKey", "pk_test_", "fixtureNotAKey"]
)
async def test_a_key_that_is_not_publishable_never_reaches_a_response(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
    key: str,
) -> None:
    """Settings refuse such a key at load (test_config); a copy that skipped validation still
    gets 503 not_configured before any row or Stripe call, and the value is never logged
    (#58, Vault round 1 B1)."""
    request_id, quote_id, _ = await accepted_request(db_session, world)
    # model_copy does not validate: the only way such a value can reach the service.
    app.state.settings = settings.model_copy(update={"stripe_publishable_key": key})

    with caplog.at_level(logging.DEBUG):
        response = await pay(db_client, world, request_id, quote_id)

    assert (response.status_code, response.json()) == (503, NOT_CONFIGURED)
    assert key not in response.text
    assert [r.message for r in caplog.records if r.levelno >= logging.ERROR] == [
        "payments_publishable_key_invalid"
    ]
    assert all(key not in JsonFormatter().format(record) for record in caplog.records)
    assert await payments_of(db_session, quote_id) == []
    assert stripe_fake.customer_calls == []


# What leaves the API


async def test_response_never_shows_payout_or_fee(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
) -> None:
    request_id, quote_id, _ = await accepted_request(db_session, world, amount=10_005)

    response = await pay(db_client, world, request_id, quote_id)

    assert response.status_code == 200, response.text
    assert set(response.json()) == SHEET_KEYS
    text = response.text.lower()
    assert not any(word in text for word in SPLIT_WORDS)
    assert "1501" not in text
    assert "8504" not in text
    schema = app.openapi()["components"]["schemas"]["PaymentSheetOut"]
    assert set(schema["properties"]) == SHEET_KEYS
    with pytest.raises(ValueError, match="Extra inputs are not permitted"):
        PaymentSheetOut.model_validate({**response.json(), "pro_payout_cents": 1})


def test_openapi_documents_the_route(app: FastAPI) -> None:
    schema = app.openapi()
    operation = schema["paths"]["/v1/requests/{request_id}/quotes/{quote_id}/payment"]["post"]

    assert {"200", "401", "403", "404", "409", "422", "502", "503"} <= set(operation["responses"])
    assert "payment_not_available" in operation["responses"]["409"]["description"]
    assert "pro_not_hireable" in operation["responses"]["409"]["description"]
    assert "not_configured" in operation["responses"]["503"]["description"]
    assert operation["tags"] == ["payments"]
    body = operation["requestBody"]
    assert body.get("required", False) is False
    components = schema["components"]["schemas"]
    assert components["PaymentCreate"].get("properties", {}) == {}
    assert components["PaymentCreate"]["additionalProperties"] is False


# What reaches the logs and Sentry


def stripe_answers() -> Callable[[httpx.Request], httpx.Response]:
    """A mock Stripe: creates succeed, the second ephemeral key is refused with a message that
    names the customer and the PaymentIntent."""
    calls: Counter[str] = Counter()
    intent = {
        "id": REAL_INTENT,
        "object": "payment_intent",
        "client_secret": REAL_CLIENT_SECRET,
        "status": "requires_payment_method",
    }

    def handle(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        calls[path] += 1
        if path == "/v1/customers":
            return httpx.Response(200, json={"id": REAL_CUSTOMER, "object": "customer"})
        if path in ("/v1/payment_intents", f"/v1/payment_intents/{REAL_INTENT}"):
            return httpx.Response(200, json=intent)
        if path == "/v1/ephemeral_keys" and calls[path] == 1:
            return httpx.Response(
                200,
                json={"id": "ephkey_x", "object": "ephemeral_key", "secret": REAL_EPHEMERAL_SECRET},
            )
        if path == "/v1/ephemeral_keys":
            return httpx.Response(
                400,
                json={
                    "error": {
                        "type": "invalid_request_error",
                        "code": "resource_missing",
                        "message": f"No such customer: '{REAL_CUSTOMER}' for {REAL_INTENT}",
                    }
                },
            )
        raise AssertionError(path)  # pragma: no cover - an unexpected Stripe call

    return handle


@pytest.fixture
async def sentry_client(
    db_session: AsyncSession, sentry_transport: MemoryTransport
) -> AsyncIterator[httpx.AsyncClient]:
    """The app with Sentry on (to memory) and the real Stripe wrapper on a mock transport."""
    app = make_app(
        make_settings(
            sentry_dsn=TEST_DSN,
            stripe_secret_key=SECRET_KEY,
            stripe_publishable_key=PUBLISHABLE_KEY,
        )
    )
    mock = httpx.AsyncClient(transport=httpx.MockTransport(stripe_answers()))
    # The SDK's own test hook: its httpx client sends through `mock`, on the mock transport.
    http = stripe.HTTPXClient(timeout=1.0, _lib=SimpleNamespace(AsyncClient=lambda **_: mock))
    app.state.stripe_payments = StripePaymentsClient(
        secret_key=SECRET_KEY, timeout_seconds=1.0, max_network_retries=0, http_client=http
    )
    app.state.rolled_back_session = db_session
    app.dependency_overrides[get_session] = _rolled_back_session
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client
    await mock.aclose()


async def test_payment_logs_and_sentry_carry_no_secrets(
    sentry_client: httpx.AsyncClient,
    sentry_transport: MemoryTransport,
    db_session: AsyncSession,
    world: World,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A full round through the real wrapper and the SDK's httpx client, then a refused call:
    Sentry's httpx integration records every Stripe URL (the PaymentIntent's retrieve names its
    id) and the error log sends an event. Neither the ids, the secrets nor the customer's
    email reach the logs or Sentry; the paths stay."""
    request_id, quote_id, _ = await accepted_request(db_session, world)

    with caplog.at_level(logging.DEBUG):
        first = await sentry_client.post(
            payment_path(request_id, quote_id), headers=customer(world)
        )
        second = await sentry_client.post(
            payment_path(request_id, quote_id), headers=customer(world)
        )
    sentry_sdk.flush()

    assert first.status_code == 200, first.text
    assert first.json()["payment_intent_client_secret"] == REAL_CLIENT_SECRET
    assert first.json()["ephemeral_key_secret"] == REAL_EPHEMERAL_SECRET
    assert (second.status_code, second.json()) == (502, PROVIDER_ERROR)
    leaks = (REAL_CUSTOMER, REAL_INTENT, REAL_CLIENT_SECRET, REAL_EPHEMERAL_SECRET, EMAIL)
    logs = rendered(caplog)
    for leak in leaks:
        assert leak not in logs, leak
    payloads = _payloads(sentry_transport)
    # The error log's own event (the 502 is also reported by the Starlette integration as a
    # handled exception; that event carries the same breadcrumbs, not the log's extras).
    events_sent = [
        e
        for e in (json.loads(p) for p in payloads)
        if e.get("logentry", {}).get("message") == "payment_stripe_rejected"
    ]
    assert events_sent, "no event was captured"
    wire = "\n".join(payloads)
    for leak in leaks:
        assert leak not in wire, leak
    for event in events_sent:
        assert event["extra"]["stripe_code"] == "resource_missing"
        assert event["extra"]["user_id"] == str(world.customer_id)
        crumbs = event["breadcrumbs"]["values"]
        # The breadcrumbs are the failing request's own (the second call: the retrieve, whose
        # URL names the PaymentIntent, and the refused ephemeral key); the id is filtered.
        stripe_urls = {
            c["data"]["url"]
            for c in crumbs
            if c.get("type") == "http" and "api.stripe.com" in c["data"]["url"]
        }
        assert stripe_urls == {
            "https://api.stripe.com/v1/payment_intents/pi_[Filtered]",
            "https://api.stripe.com/v1/ephemeral_keys",
        }


async def _quotes(session: AsyncSession, request_id: uuid.UUID) -> list[Any]:
    from tests.test_quotes_api import quotes_of

    return await quotes_of(session, request_id)
