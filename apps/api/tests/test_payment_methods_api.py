"""/v1/me/payment-methods: the customer's saved cards, the wallet in their profile (#253).
Never calls Stripe: fakes replace both wrappers."""

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field, replace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db import get_session
from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_payment_methods import (
    CreatedSetupIntent,
    SavedCard,
    StripePaymentMethods,
    get_stripe_payment_methods,
)
from app.integrations.stripe_payments import StripePayments, get_stripe_payments
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from app.rate_limit import get_rate_limiter, window_position
from tests.conftest import (
    LOCK_WAIT_DEADLINE_SECONDS,
    Committed,
    InMemoryRateLimiter,
    make_app,
    make_settings,
)
from tests.test_auth_api import register as register_account
from tests.test_devices_api import caller
from tests.test_payments_api import FakeStripePayments

BASE = "/v1/me/payment-methods"
SETUP = f"{BASE}/setup-intent"
# Fixture values only: a test-mode-shaped key that is not a key.
PUBLISHABLE_KEY = "pk_test_fixtureWallet253"
SETUP_KEYS = {"client_secret", "ephemeral_key_secret", "customer_id", "publishable_key"}
CARD_KEYS = {"id", "brand", "last4", "exp_month", "exp_year", "is_default"}
NOT_FOUND = {"error": {"code": "payment_method_not_found", "message": "Payment method not found."}}
FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}
NOT_CONFIGURED = {
    "error": {"code": "not_configured", "message": "Payments are not configured yet."}
}
UNAVAILABLE = {
    "error": {
        "code": "payments_unavailable",
        "message": "Payments are unavailable right now. Try again later.",
    }
}
RATE_LIMITED = {"error": {"code": "rate_limited", "message": "Too many requests. Try again later."}}
NOW = 1_800_000_000.0  # a fixed clock, so no test straddles two rate-limit windows
WRITE_LIMIT = 3
WRITE_WINDOW = 120
# Stripe's code for a request whose idempotency key has its first request still in flight.
KEY_IN_USE = "idempotency_key_in_use"
# What Stripe's own errors carry and no response may show.
STRIPE_REQUEST_ID = "req_zqstripeleak"
STRIPE_CODE = "zq_stripe_code_leak"
# Sentinels no clock, uuid or id can spell: what the logs must never hold.
SECRET_SENTINEL = "ZQSETUPSECRETZQ"
BRAND_SENTINEL = "zqbrandzq"
LAST4_SENTINEL = "zqxj"
EXP_YEAR_SENTINEL = 73_591_846


@dataclass
class FakeStripePaymentMethods:
    """Keeps cards as Stripe does and records every call, in order. `errors` makes one
    operation fail, after the call is recorded. A card whose `customer_id` is None is detached.
    `list_cards` answers the oldest first, the reverse of what the API must return.
    `clears_default_on_detach` False: Stripe keeps pointing at a detached default."""

    cards: dict[str, SavedCard] = field(default_factory=dict)
    defaults: dict[str, str] = field(default_factory=dict)  # customer id -> PaymentMethod id
    errors: dict[str, Exception] = field(default_factory=dict)
    calls: list[tuple[str, ...]] = field(default_factory=list)
    clears_default_on_detach: bool = True
    clock: int = 1_790_000_000

    def add_card(self, customer_id: str | None, **fields: Any) -> SavedCard:
        """A card attached to the customer, a minute newer than the last one added."""
        self.clock += 60
        values: dict[str, Any] = {
            "payment_method_id": f"pm_fake{len(self.cards)}{uuid.uuid4().hex[:8]}",
            "customer_id": customer_id,
            "brand": "visa",
            "last4": "4242",
            "exp_month": 12,
            "exp_year": 2030,
            "created": self.clock,
        }
        values.update(fields)
        card = SavedCard(**values)
        self.cards[card.payment_method_id] = card
        return card

    def attached(self, customer_id: str) -> list[str]:
        return [c.payment_method_id for c in self.cards.values() if c.customer_id == customer_id]

    def operations(self) -> list[str]:
        return [call[0] for call in self.calls]

    def _begin(self, operation: str, *args: str) -> None:
        self.calls.append((operation, *args))
        if operation in self.errors:
            raise self.errors[operation]

    async def create_setup_intent(self, customer_id: str) -> CreatedSetupIntent:
        self._begin("create_setup_intent", customer_id)
        return CreatedSetupIntent(
            client_secret=f"seti_fake{len(self.calls)}_secret_{SECRET_SENTINEL}{uuid.uuid4().hex}",
            request_id="req_fake_setup",
        )

    async def list_cards(self, customer_id: str) -> tuple[SavedCard, ...]:
        self._begin("list_cards", customer_id)
        return tuple(card for card in self.cards.values() if card.customer_id == customer_id)

    async def retrieve_card(self, payment_method_id: str) -> SavedCard | None:
        self._begin("retrieve_card", payment_method_id)
        return self.cards.get(payment_method_id)

    async def default_payment_method(self, customer_id: str) -> str | None:
        self._begin("default_payment_method", customer_id)
        return self.defaults.get(customer_id)

    async def set_default_payment_method(self, customer_id: str, payment_method_id: str) -> None:
        self._begin("set_default_payment_method", customer_id, payment_method_id)
        card = self.cards.get(payment_method_id)
        if card is None or card.customer_id != customer_id:
            # As Stripe does for a PaymentMethod that is not the customer's.
            raise StripeRejectedError(request_id="req_fake_default", code="resource_missing")
        self.defaults[customer_id] = payment_method_id

    async def detach(self, payment_method_id: str) -> None:
        self._begin("detach", payment_method_id)
        card = self.cards[payment_method_id]
        self.cards[payment_method_id] = replace(card, customer_id=None)
        if (
            self.clears_default_on_detach
            and card.customer_id is not None
            and self.defaults.get(card.customer_id) == payment_method_id
        ):
            del self.defaults[card.customer_id]


@dataclass
class Fakes:
    payments: FakeStripePayments
    methods: FakeStripePaymentMethods


def _fake_payments(request: Request) -> StripePayments:
    """One override for every test (a closure per test would stay in FastAPI's caches, #196)."""
    fake: FakeStripePayments = request.app.state.fake_stripe_payments
    return fake


def _fake_methods(request: Request) -> StripePaymentMethods:
    fake: FakeStripePaymentMethods = request.app.state.fake_stripe_payment_methods
    return fake


def install_fakes(app: FastAPI) -> Fakes:
    app.state.fake_stripe_payments = FakeStripePayments()
    app.state.fake_stripe_payment_methods = FakeStripePaymentMethods()
    app.dependency_overrides[get_stripe_payments] = _fake_payments
    app.dependency_overrides[get_stripe_payment_methods] = _fake_methods
    return Fakes(app.state.fake_stripe_payments, app.state.fake_stripe_payment_methods)


@pytest.fixture
def settings() -> Settings:
    # The secret key is passed as None so a STRIPE_SECRET_KEY in the shell never reaches the
    # app: without the fakes, the real dependencies find no Stripe.
    return make_settings(stripe_secret_key=None, stripe_publishable_key=PUBLISHABLE_KEY)


@pytest.fixture
def fakes(app: FastAPI) -> Fakes:
    return install_fakes(app)


async def customer_with_stripe(
    session: AsyncSession, role: UserRole = UserRole.CUSTOMER
) -> tuple[uuid.UUID, dict[str, str], str]:
    """A user whose Stripe Customer is stored already: the id, the auth headers, the customer."""
    user_id, headers = await caller(session, role)
    customer_id = f"cus_fake{uuid.uuid4().hex[:12]}"
    await session.execute(
        update(User).where(User.id == user_id).values(stripe_customer_id=customer_id)
    )
    await session.flush()
    return user_id, headers, customer_id


async def stored_customer(session: AsyncSession, user_id: uuid.UUID) -> str | None:
    return await session.scalar(select(User.stripe_customer_id).where(User.id == user_id))


def default_path(payment_method_id: str) -> str:
    return f"{BASE}/{payment_method_id}/default"


# AC1: the setup intent, and the customer created once


async def test_setup_intent_creates_the_customer_once_and_returns_what_the_sheet_needs(
    db_client: httpx.AsyncClient, db_session: AsyncSession, fakes: Fakes
) -> None:
    user_id, headers = await caller(db_session)

    first = await db_client.post(SETUP, headers=headers)
    second = await db_client.post(SETUP, headers=headers)

    assert (first.status_code, second.status_code) == (200, 200)
    body, again = first.json(), second.json()
    assert set(body) == set(again) == SETUP_KEYS
    assert body["publishable_key"] == PUBLISHABLE_KEY
    # One customer, created with the user's key and no PII, stored on the user.
    assert fakes.payments.customer_calls == [
        {"user_id": str(user_id), "idempotency_key": f"customer:{user_id}"}
    ]
    assert body["customer_id"] == again["customer_id"] == await stored_customer(db_session, user_id)
    # A new SetupIntent and a new ephemeral key on every call, both for that customer.
    assert body["client_secret"] != again["client_secret"]
    assert body["ephemeral_key_secret"] != again["ephemeral_key_secret"]
    assert fakes.methods.calls == [("create_setup_intent", body["customer_id"])] * 2
    assert fakes.payments.ephemeral_keys == [body["customer_id"]] * 2


async def test_setup_intent_reuses_the_customer_a_payment_created(
    db_client: httpx.AsyncClient, db_session: AsyncSession, fakes: Fakes
) -> None:
    _, headers, customer_id = await customer_with_stripe(db_session)

    response = await db_client.post(SETUP, headers=headers)

    assert response.status_code == 200
    assert response.json()["customer_id"] == customer_id
    assert fakes.payments.customer_calls == []


async def test_setup_intent_takes_no_customer_from_the_client(
    db_client: httpx.AsyncClient, db_session: AsyncSession, fakes: Fakes
) -> None:
    """The customer is the caller's stored one whatever the body says."""
    _, ana, ana_customer = await customer_with_stripe(db_session)
    _, _, bruno_customer = await customer_with_stripe(db_session)

    response = await db_client.post(SETUP, headers=ana, json={"customer_id": bruno_customer})

    assert response.json()["customer_id"] == ana_customer
    assert fakes.methods.calls == [("create_setup_intent", ana_customer)]
    assert fakes.payments.ephemeral_keys == [ana_customer]


async def test_two_first_setup_intents_at_once_make_one_customer(
    app: FastAPI, committed: Committed
) -> None:
    """A double tap. Stripe answers a key whose first request is still in flight with a 409
    (idempotency_key_in_use), so the second call must not reach Stripe: it waits on the user's
    row, which the first holds until the customer is stored, and reads the stored id."""
    fakes = install_fakes(app)
    account = (await register_account(committed.client, email=committed.email)).json()
    user_id = uuid.UUID(account["user"]["id"])
    headers = {"Authorization": f"Bearer {account['access_token']}"}
    waiting = text(
        "SELECT count(*) FROM pg_stat_activity "
        "WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0"
    )
    in_flight = False

    async def as_stripe_with_a_create_in_flight() -> None:
        nonlocal in_flight
        if in_flight:
            raise StripeUnavailableError(request_id="req_fake_in_use", code=KEY_IN_USE)
        in_flight = True
        try:
            # Answers only once the other call is waiting on a lock: the race is real. Each
            # poll is the query itself, on its own connection.
            async with committed.sessions() as monitor, asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
                while not await monitor.scalar(waiting):
                    pass
        except TimeoutError:
            pytest.fail("the second call never waited on the lock of the first")
        finally:
            in_flight = False

    fakes.payments.on_create_customer = as_stripe_with_a_create_in_flight

    first, second = await asyncio.gather(
        committed.client.post(SETUP, headers=headers),
        committed.client.post(SETUP, headers=headers),
    )

    assert (first.status_code, second.status_code) == (200, 200)
    # One create reached Stripe; the other call read what it stored.
    key = f"customer:{user_id}"
    assert [call["idempotency_key"] for call in fakes.payments.customer_calls] == [key]
    async with committed.sessions() as check:
        stored = await stored_customer(check, user_id)
    assert first.json()["customer_id"] == second.json()["customer_id"] == stored
    assert stored == fakes.payments.customers[key]
    # Each call still got its own SetupIntent, for the one customer.
    assert fakes.methods.calls == [("create_setup_intent", stored)] * 2


async def test_a_customer_create_stripe_has_in_flight_is_503_and_the_next_call_works(
    db_client: httpx.AsyncClient, db_session: AsyncSession, fakes: Fakes
) -> None:
    """Racing a first payment's create (#58, which takes no lock) Stripe may answer the 409:
    503, nothing stored or created after it, and the call can be made again."""
    user_id, headers = await caller(db_session)
    fakes.payments.errors["create_customer"] = StripeUnavailableError(
        request_id="req_fake_in_use", code=KEY_IN_USE
    )

    refused = await db_client.post(SETUP, headers=headers)
    stored_after_refusal = await stored_customer(db_session, user_id)
    del fakes.payments.errors["create_customer"]
    again = await db_client.post(SETUP, headers=headers)

    assert (refused.status_code, refused.json()) == (503, UNAVAILABLE)
    assert stored_after_refusal is None
    assert again.status_code == 200
    assert again.json()["customer_id"] == await stored_customer(db_session, user_id)
    assert fakes.methods.calls == [("create_setup_intent", again.json()["customer_id"])]


# AC2: the list


async def test_list_is_empty_without_a_customer_and_never_asks_stripe(
    db_client: httpx.AsyncClient, db_session: AsyncSession, fakes: Fakes
) -> None:
    user_id, headers = await caller(db_session)

    response = await db_client.get(BASE, headers=headers)

    assert (response.status_code, response.json()) == (200, [])
    assert fakes.methods.calls == []
    assert fakes.payments.customer_calls == []
    assert await stored_customer(db_session, user_id) is None  # a read creates no customer


async def test_list_returns_the_wallet_fields_only_newest_first(
    db_client: httpx.AsyncClient, db_session: AsyncSession, fakes: Fakes
) -> None:
    _, ana, ana_customer = await customer_with_stripe(db_session)
    _, bruno, bruno_customer = await customer_with_stripe(db_session)
    oldest = fakes.methods.add_card(ana_customer, brand="visa", last4="4242")
    middle = fakes.methods.add_card(ana_customer, brand="mastercard", last4="4444", exp_month=3)
    fakes.methods.add_card(bruno_customer, brand="amex", last4="0005")
    newest = fakes.methods.add_card(ana_customer, brand="discover", last4="1117", exp_year=2031)
    fakes.methods.defaults[ana_customer] = middle.payment_method_id

    response = await db_client.get(BASE, headers=ana)
    theirs = await db_client.get(BASE, headers=bruno)

    assert response.status_code == 200
    assert response.json() == [
        {
            "id": newest.payment_method_id,
            "brand": "discover",
            "last4": "1117",
            "exp_month": 12,
            "exp_year": 2031,
            "is_default": False,
        },
        {
            "id": middle.payment_method_id,
            "brand": "mastercard",
            "last4": "4444",
            "exp_month": 3,
            "exp_year": 2030,
            "is_default": True,
        },
        {
            "id": oldest.payment_method_id,
            "brand": "visa",
            "last4": "4242",
            "exp_month": 12,
            "exp_year": 2030,
            "is_default": False,
        },
    ]
    assert all(set(item) == CARD_KEYS for item in response.json())
    # Bruno sees his own card only, and no default: he set none.
    assert [(item["last4"], item["is_default"]) for item in theirs.json()] == [("0005", False)]


# AC3: the default and the delete


async def test_set_default_moves_the_default(
    db_client: httpx.AsyncClient, db_session: AsyncSession, fakes: Fakes
) -> None:
    _, headers, customer_id = await customer_with_stripe(db_session)
    first = fakes.methods.add_card(customer_id, last4="4242")
    second = fakes.methods.add_card(customer_id, last4="4444")
    fakes.methods.defaults[customer_id] = first.payment_method_id

    response = await db_client.post(default_path(second.payment_method_id), headers=headers)
    repeated = await db_client.post(default_path(second.payment_method_id), headers=headers)
    listed = await db_client.get(BASE, headers=headers)

    assert (response.status_code, repeated.status_code) == (200, 200)
    assert response.json() == repeated.json()
    assert response.json() == {
        "id": second.payment_method_id,
        "brand": "visa",
        "last4": "4444",
        "exp_month": 12,
        "exp_year": 2030,
        "is_default": True,
    }
    assert fakes.methods.defaults == {customer_id: second.payment_method_id}
    assert [(item["last4"], item["is_default"]) for item in listed.json()] == [
        ("4444", True),
        ("4242", False),
    ]


async def test_delete_detaches_a_card_and_keeps_the_default(
    db_client: httpx.AsyncClient, db_session: AsyncSession, fakes: Fakes
) -> None:
    _, headers, customer_id = await customer_with_stripe(db_session)
    kept = fakes.methods.add_card(customer_id)
    gone = fakes.methods.add_card(customer_id)
    fakes.methods.defaults[customer_id] = kept.payment_method_id

    response = await db_client.delete(f"{BASE}/{gone.payment_method_id}", headers=headers)
    again = await db_client.delete(f"{BASE}/{gone.payment_method_id}", headers=headers)

    assert (response.status_code, response.content) == (204, b"")
    assert fakes.methods.attached(customer_id) == [kept.payment_method_id]
    assert fakes.methods.defaults == {customer_id: kept.payment_method_id}
    # Not the default: nothing is listed or promoted, the card is only detached.
    assert fakes.methods.operations()[:3] == ["retrieve_card", "default_payment_method", "detach"]
    # A card deleted already is the one 404.
    assert (again.status_code, again.json()) == (404, NOT_FOUND)


async def test_deleting_the_default_promotes_the_most_recently_added_other_card(
    db_client: httpx.AsyncClient, db_session: AsyncSession, fakes: Fakes
) -> None:
    _, headers, customer_id = await customer_with_stripe(db_session)
    oldest = fakes.methods.add_card(customer_id, last4="0001")
    default = fakes.methods.add_card(customer_id, last4="0002")
    newest = fakes.methods.add_card(customer_id, last4="0003")
    fakes.methods.defaults[customer_id] = default.payment_method_id

    response = await db_client.delete(f"{BASE}/{default.payment_method_id}", headers=headers)
    listed = await db_client.get(BASE, headers=headers)

    assert response.status_code == 204
    assert fakes.methods.defaults == {customer_id: newest.payment_method_id}
    assert [(item["last4"], item["is_default"]) for item in listed.json()] == [
        ("0003", True),
        ("0001", False),
    ]
    assert oldest.payment_method_id in fakes.methods.attached(customer_id)
    # The next default is set before the detach: a failure between them leaves a default.
    assert fakes.methods.calls[:5] == [
        ("retrieve_card", default.payment_method_id),
        ("default_payment_method", customer_id),
        ("list_cards", customer_id),
        ("set_default_payment_method", customer_id, newest.payment_method_id),
        ("detach", default.payment_method_id),
    ]


@pytest.mark.parametrize("stripe_clears", [True, False], ids=["cleared", "dangling"])
async def test_deleting_the_only_card_leaves_no_default(
    db_client: httpx.AsyncClient, db_session: AsyncSession, fakes: Fakes, stripe_clears: bool
) -> None:
    """With no other card none is promoted; and a default Stripe would keep pointing at the
    detached card shows on no card."""
    _, headers, customer_id = await customer_with_stripe(db_session)
    only = fakes.methods.add_card(customer_id)
    fakes.methods.defaults[customer_id] = only.payment_method_id
    fakes.methods.clears_default_on_detach = stripe_clears

    response = await db_client.delete(f"{BASE}/{only.payment_method_id}", headers=headers)
    listed = await db_client.get(BASE, headers=headers)

    assert response.status_code == 204
    assert "set_default_payment_method" not in fakes.methods.operations()
    assert listed.json() == []
    # A card added later is not the default by itself.
    fakes.methods.add_card(customer_id, last4="9999")
    later = await db_client.get(BASE, headers=headers)
    assert [(item["last4"], item["is_default"]) for item in later.json()] == [("9999", False)]


@pytest.mark.parametrize("action", ["default", "delete"])
async def test_another_users_card_is_the_same_404_as_an_unknown_one(
    db_client: httpx.AsyncClient, db_session: AsyncSession, fakes: Fakes, action: str
) -> None:
    """IDOR: Ana addresses Bruno's card by its id. The answer, and what Stripe was asked, are
    those of an id that does not exist; Bruno's wallet is untouched."""
    _, ana, ana_customer = await customer_with_stripe(db_session)
    _, _, bruno_customer = await customer_with_stripe(db_session)
    mine = fakes.methods.add_card(ana_customer)
    theirs = fakes.methods.add_card(bruno_customer)
    other = fakes.methods.add_card(bruno_customer)
    detached = fakes.methods.add_card(None)
    fakes.methods.defaults = {
        ana_customer: mine.payment_method_id,
        bruno_customer: other.payment_method_id,
    }
    before = (dict(fakes.methods.cards), dict(fakes.methods.defaults))

    async def act(payment_method_id: str) -> httpx.Response:
        if action == "default":
            return await db_client.post(default_path(payment_method_id), headers=ana)
        return await db_client.delete(f"{BASE}/{payment_method_id}", headers=ana)

    answers = {}
    asked = {}
    for name, payment_method_id in (
        ("theirs", theirs.payment_method_id),
        ("their default", other.payment_method_id),
        ("unknown", "pm_fakeunknown0123"),
        ("detached", detached.payment_method_id),
    ):
        fakes.methods.calls.clear()
        answers[name] = await act(payment_method_id)
        asked[name] = fakes.methods.calls.copy()

    for name, answer in answers.items():
        assert (answer.status_code, answer.json()) == (404, NOT_FOUND), name
        assert answer.headers.items() >= {"content-type": "application/json"}.items()
        # One read each, and nothing after it: no default set, nothing detached.
        assert [call[0] for call in asked[name]] == ["retrieve_card"], name
    assert len({answer.content for answer in answers.values()}) == 1
    assert (fakes.methods.cards, fakes.methods.defaults) == before


@pytest.mark.parametrize("action", ["default", "delete"])
async def test_a_caller_without_a_customer_gets_the_same_404(
    db_client: httpx.AsyncClient, db_session: AsyncSession, fakes: Fakes, action: str
) -> None:
    _, headers = await caller(db_session)
    _, _, bruno_customer = await customer_with_stripe(db_session)
    theirs = fakes.methods.add_card(bruno_customer)

    if action == "default":
        response = await db_client.post(default_path(theirs.payment_method_id), headers=headers)
    else:
        response = await db_client.delete(f"{BASE}/{theirs.payment_method_id}", headers=headers)

    assert (response.status_code, response.json()) == (404, NOT_FOUND)
    assert fakes.methods.calls == []
    assert fakes.methods.attached(bruno_customer) == [theirs.payment_method_id]


@pytest.mark.parametrize(
    "payment_method_id",
    [
        "card_1Abc",  # not a PaymentMethod id
        "pm_",  # the prefix alone
        "PM_1Abc",
        "pm_1Abc-def",
        "pm_1Abc.def",
        "pm_1Abc%3Fexpand",  # an encoded query
        "pm_1Abc%5C..%5Ccustomers",  # an encoded backslash path
        "pm_1Abc def",
        "pm_" + "a" * 253,  # past the 255 characters Stripe allows an id
        "pm_caf%C3%A9",  # not ASCII
        "pm_1Abc%0A",  # a trailing newline
    ],
)
async def test_a_malformed_id_is_422_before_anything_is_asked(
    db_client: httpx.AsyncClient, db_session: AsyncSession, fakes: Fakes, payment_method_id: str
) -> None:
    _, headers, _ = await customer_with_stripe(db_session)

    made_default = await db_client.post(default_path(payment_method_id), headers=headers)
    deleted = await db_client.delete(f"{BASE}/{payment_method_id}", headers=headers)

    for response in (made_default, deleted):
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"
    assert fakes.methods.calls == []


async def test_an_encoded_slash_in_the_id_matches_no_route(
    db_client: httpx.AsyncClient, db_session: AsyncSession, fakes: Fakes
) -> None:
    """The server decodes %2F before routing, so the id never reaches the handler."""
    _, headers, _ = await customer_with_stripe(db_session)
    encoded = "pm_1Abc%2F..%2Fcustomers"

    made_default = await db_client.post(default_path(encoded), headers=headers)
    deleted = await db_client.delete(f"{BASE}/{encoded}", headers=headers)

    assert (made_default.status_code, deleted.status_code) == (404, 404)
    assert fakes.methods.calls == []


async def test_the_longest_id_stripe_allows_is_accepted(
    db_client: httpx.AsyncClient, db_session: AsyncSession, fakes: Fakes
) -> None:
    _, headers, customer_id = await customer_with_stripe(db_session)
    card = fakes.methods.add_card(customer_id, payment_method_id="pm_" + "a_9Z" * 63)
    assert len(card.payment_method_id) == 255

    response = await db_client.post(default_path(card.payment_method_id), headers=headers)

    assert response.status_code == 200


# AC4: Stripe failing


SETUP_OPERATIONS = ("create_customer", "create_setup_intent", "create_ephemeral_key")
FAILURES = [
    ("setup", "create_customer"),
    ("setup", "create_setup_intent"),
    ("setup", "create_ephemeral_key"),
    ("list", "list_cards"),
    ("list", "default_payment_method"),
    ("default", "retrieve_card"),
    ("default", "set_default_payment_method"),
    ("delete", "retrieve_card"),
    ("delete", "default_payment_method"),
    ("delete", "list_cards"),
    ("delete", "set_default_payment_method"),
    ("delete", "detach"),
]


@pytest.mark.parametrize(("route", "operation"), FAILURES)
@pytest.mark.parametrize(
    "error",
    [StripeUnavailableError, StripeRejectedError],
    ids=["unavailable", "rejected"],
)
async def test_any_stripe_failure_is_one_stable_503(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    fakes: Fakes,
    caplog: pytest.LogCaptureFixture,
    route: str,
    operation: str,
    error: type[StripeUnavailableError] | type[StripeRejectedError],
) -> None:
    """An outage, a timeout, a 429 and a refusal answer alike: 503 payments_unavailable, with
    nothing of Stripe's in it, and the failing call made once (no retry)."""
    if route == "setup":
        user_id, headers = await caller(db_session)
        customer_id = None
    else:
        user_id, headers, customer_id = await customer_with_stripe(db_session)
    default = fakes.methods.add_card(customer_id)
    fakes.methods.add_card(customer_id)
    if customer_id is not None:
        fakes.methods.defaults[customer_id] = default.payment_method_id
    failure = error(request_id=STRIPE_REQUEST_ID, code=STRIPE_CODE)
    fakes.payments.errors[operation] = failure
    fakes.methods.errors[operation] = failure

    with caplog.at_level(logging.DEBUG):
        if route == "setup":
            response = await db_client.post(SETUP, headers=headers)
        elif route == "list":
            response = await db_client.get(BASE, headers=headers)
        elif route == "default":
            response = await db_client.post(
                default_path(default.payment_method_id), headers=headers
            )
        else:
            response = await db_client.delete(
                f"{BASE}/{default.payment_method_id}", headers=headers
            )

    assert (response.status_code, response.json()) == (503, UNAVAILABLE)
    assert STRIPE_REQUEST_ID not in response.text
    assert STRIPE_CODE not in response.text
    assert "Retry-After" not in response.headers
    if operation not in SETUP_OPERATIONS or operation == "create_setup_intent":
        assert fakes.methods.operations().count(operation) == 1  # asked once, not again
    # The log tells an outage from a refusal, with ids and Stripe's request id and code only.
    event = "payment_method_stripe_" + (
        "unavailable" if error is StripeUnavailableError else "rejected"
    )
    [record] = [r for r in caplog.records if r.message == event]
    logged = json.loads(JsonFormatter().format(record))
    assert logged["level"] == "ERROR"
    assert {k: logged[k] for k in ("user_id", "operation", "stripe_request_id", "stripe_code")} == {
        "user_id": str(user_id),
        "operation": operation,
        "stripe_request_id": STRIPE_REQUEST_ID,
        "stripe_code": STRIPE_CODE,
    }
    if operation == "create_customer":
        assert await stored_customer(db_session, user_id) is None


async def test_a_detach_that_fails_after_the_promotion_leaves_a_default_and_can_be_retried(
    db_client: httpx.AsyncClient, db_session: AsyncSession, fakes: Fakes
) -> None:
    _, headers, customer_id = await customer_with_stripe(db_session)
    other = fakes.methods.add_card(customer_id)
    default = fakes.methods.add_card(customer_id)
    fakes.methods.defaults[customer_id] = default.payment_method_id
    fakes.methods.errors["detach"] = StripeUnavailableError(request_id="req_fake_detach")

    failed = await db_client.delete(f"{BASE}/{default.payment_method_id}", headers=headers)
    del fakes.methods.errors["detach"]
    retried = await db_client.delete(f"{BASE}/{default.payment_method_id}", headers=headers)

    assert (failed.status_code, retried.status_code) == (503, 204)
    assert fakes.methods.defaults == {customer_id: other.payment_method_id}
    assert fakes.methods.attached(customer_id) == [other.payment_method_id]


async def test_without_stripe_every_route_is_503_not_configured(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """No STRIPE_SECRET_KEY (allowed outside staging and production), no fake."""
    _, headers, _ = await customer_with_stripe(db_session)

    responses = [
        await db_client.post(SETUP, headers=headers),
        await db_client.get(BASE, headers=headers),
        await db_client.post(default_path("pm_1Abc"), headers=headers),
        await db_client.delete(f"{BASE}/pm_1Abc", headers=headers),
    ]

    assert [(r.status_code, r.json()) for r in responses] == [(503, NOT_CONFIGURED)] * 4


@pytest.mark.parametrize("publishable_key", [None, "sk_test_notApublishableKey"])
async def test_setup_intent_needs_the_publishable_key(
    db_session: AsyncSession, publishable_key: str | None
) -> None:
    """Without it the sheet cannot start, so nothing is created. A key that is not a pk_ key
    (settings built without validation) is never returned."""
    settings = make_settings(stripe_secret_key=None, stripe_publishable_key=None)
    app = make_app(settings.model_copy(update={"stripe_publishable_key": publishable_key}))
    fakes = install_fakes(app)

    async def test_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = test_session
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        user_id, headers = await caller(db_session)
        response = await client.post(SETUP, headers=headers)
        listed = await client.get(BASE, headers=headers)

    assert (response.status_code, response.json()) == (503, NOT_CONFIGURED)
    assert "sk_test" not in response.text
    assert fakes.payments.customer_calls == []
    assert fakes.methods.calls == []
    assert await stored_customer(db_session, user_id) is None
    assert listed.status_code == 200  # the list needs no publishable key


async def test_no_secret_or_card_data_in_logs(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    fakes: Fakes,
    caplog: pytest.LogCaptureFixture,
) -> None:
    user_id, headers = await caller(db_session)

    with caplog.at_level(logging.DEBUG):
        setup = await db_client.post(SETUP, headers=headers)
        customer_id = setup.json()["customer_id"]
        fields = {"brand": BRAND_SENTINEL, "last4": LAST4_SENTINEL, "exp_year": EXP_YEAR_SENTINEL}
        first = fakes.methods.add_card(customer_id, **fields)
        second = fakes.methods.add_card(customer_id, **fields)
        listed = await db_client.get(BASE, headers=headers)
        made_default = await db_client.post(default_path(second.payment_method_id), headers=headers)
        deleted = await db_client.delete(f"{BASE}/{second.payment_method_id}", headers=headers)
        missing = await db_client.delete(f"{BASE}/{second.payment_method_id}", headers=headers)

    statuses = [r.status_code for r in (setup, listed, made_default, deleted, missing)]
    assert statuses == [200, 200, 200, 204, 404]
    assert SECRET_SENTINEL in setup.json()["client_secret"]  # the response has it, logs never
    lines = [JsonFormatter().format(record) for record in caplog.records]
    output = "\n".join(lines)
    for piece in (
        SECRET_SENTINEL,
        setup.json()["client_secret"],
        setup.json()["ephemeral_key_secret"],
        customer_id,
        PUBLISHABLE_KEY,
        BRAND_SENTINEL,
        LAST4_SENTINEL,
        str(EXP_YEAR_SENTINEL),
    ):
        assert piece not in output
    # A PaymentMethod id shows only where the route itself has it: the access log's path.
    for payment_method_id in (first.payment_method_id, second.payment_method_id):
        holders = [json.loads(line) for line in lines if payment_method_id in line]
        assert all(
            entry["message"] == "request" and payment_method_id in entry["path"]
            for entry in holders
        )
    events = {
        record.message: json.loads(JsonFormatter().format(record))
        for record in caplog.records
        if record.message.startswith(("payment_method_", "stripe_customer_"))
    }
    standard = {"timestamp", "level", "logger", "message", "request_id"}
    assert set(events["stripe_customer_created"]) - standard == {"user_id", "stripe_request_id"}
    assert set(events["payment_method_setup_intent_issued"]) - standard == {
        "user_id",
        "stripe_request_id",
    }
    assert set(events["payment_method_default_set"]) - standard == {"user_id"}
    assert set(events["payment_method_deleted"]) - standard == {
        "user_id",
        "was_default",
        "promoted",
    }
    assert events["payment_method_deleted"]["user_id"] == str(user_id)
    assert (
        events["payment_method_deleted"]["was_default"],
        events["payment_method_deleted"]["promoted"],
    ) == (True, True)


# AC6: access, the rate limit, the contract


@pytest.mark.parametrize("role", [UserRole.PRO, UserRole.AGENT, UserRole.ADMIN])
async def test_only_customers_have_a_wallet(
    db_client: httpx.AsyncClient, db_session: AsyncSession, fakes: Fakes, role: UserRole
) -> None:
    _user_id, headers, customer_id = await customer_with_stripe(db_session, role)
    card = fakes.methods.add_card(customer_id)

    responses = [
        await db_client.post(SETUP, headers=headers),
        await db_client.get(BASE, headers=headers),
        await db_client.post(default_path(card.payment_method_id), headers=headers),
        await db_client.delete(f"{BASE}/{card.payment_method_id}", headers=headers),
    ]

    assert [(r.status_code, r.json()) for r in responses] == [(403, FORBIDDEN)] * 4
    assert fakes.methods.calls == []
    assert fakes.payments.customer_calls == []
    assert fakes.methods.attached(customer_id) == [card.payment_method_id]


async def test_unauthenticated_401(db_client: httpx.AsyncClient, fakes: Fakes) -> None:
    for response in (
        await db_client.post(SETUP),
        await db_client.get(BASE),
        await db_client.post(default_path("pm_1Abc")),
        await db_client.delete(f"{BASE}/pm_1Abc"),
        await db_client.get(BASE, headers={"Authorization": "Bearer not-a-token"}),
    ):
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "invalid_token"
    assert fakes.methods.calls == []


async def test_setup_intents_and_changes_share_one_limit_per_customer(
    db_session: AsyncSession,
) -> None:
    app = make_app(
        make_settings(
            stripe_secret_key=None,
            stripe_publishable_key=PUBLISHABLE_KEY,
            payment_method_write_limit=WRITE_LIMIT,
            payment_method_write_window_seconds=WRITE_WINDOW,
        )
    )
    fakes = install_fakes(app)
    limiter = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter

    async def test_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = test_session
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        ana_id, ana, ana_customer = await customer_with_stripe(db_session)
        bruno_id, bruno, _ = await customer_with_stripe(db_session)
        kept = fakes.methods.add_card(ana_customer)
        gone = fakes.methods.add_card(ana_customer)
        setup = await client.post(SETUP, headers=ana)
        made_default = await client.post(default_path(kept.payment_method_id), headers=ana)
        deleted = await client.delete(f"{BASE}/{gone.payment_method_id}", headers=ana)  # the limit
        calls = len(fakes.methods.calls)
        limited = [
            await client.post(SETUP, headers=ana),
            await client.post(default_path(kept.payment_method_id), headers=ana),
            await client.delete(f"{BASE}/{kept.payment_method_id}", headers=ana),
        ]
        after_limit = len(fakes.methods.calls)
        reads = await client.get(BASE, headers=ana)
        other = await client.post(SETUP, headers=bruno)

    assert [r.status_code for r in (setup, made_default, deleted)] == [200, 200, 204]
    for response in limited:
        assert (response.status_code, response.json()) == (429, RATE_LIMITED)
        assert int(response.headers["Retry-After"]) >= 1
    assert after_limit == calls  # a limited request never reaches Stripe
    assert reads.status_code == 200
    assert len(reads.json()) == 1
    assert other.status_code == 200  # another customer has their own budget
    index, _ = window_position(NOW, WRITE_WINDOW)
    assert limiter.counts == {  # the key is the user id only
        f"payment_method_write:{ana_id}:{index}": WRITE_LIMIT + 3,
        f"payment_method_write:{bruno_id}:{index}": 1,
    }


def test_openapi_documents_every_error_and_only_the_wallet_fields(app: FastAPI) -> None:
    schema = app.openapi()
    paths = schema["paths"]
    item = f"{BASE}/{{payment_method_id}}"

    def responses(path: str, method: str) -> dict[str, Any]:
        documented: dict[str, Any] = paths[path][method]["responses"]
        return documented

    routes = {
        (SETUP, "post"): {"200", "401", "403", "422", "429", "503"},
        (BASE, "get"): {"200", "401", "403", "422", "503"},
        (f"{item}/default", "post"): {"200", "401", "403", "404", "422", "429", "503"},
        (item, "delete"): {"204", "401", "403", "404", "422", "429", "503"},
    }
    for (path, method), statuses in routes.items():
        documented = responses(path, method)
        assert set(documented) == statuses, (path, method)
        for status in statuses - {"200", "204"}:
            content = documented[status]["content"]["application/json"]["schema"]
            assert content == {"$ref": "#/components/schemas/ErrorResponse"}, (path, status)
        assert "not_configured" in documented["503"]["description"]
        assert "payments_unavailable" in documented["503"]["description"]
        if "429" in statuses:
            assert "rate_limited" in documented["429"]["description"]
            assert "Retry-After" in documented["429"]["headers"]
        if "404" in statuses:
            assert "payment_method_not_found" in documented["404"]["description"]
            [parameter] = paths[path][method]["parameters"]
            assert parameter["schema"]["pattern"] == "^pm_[A-Za-z0-9_]{1,252}$"
    schemas = schema["components"]["schemas"]
    assert set(schemas["PaymentMethodOut"]["properties"]) == CARD_KEYS
    assert set(schemas["PaymentMethodOut"]["required"]) == CARD_KEYS
    assert set(schemas["SetupIntentOut"]["properties"]) == SETUP_KEYS
    listed = responses(BASE, "get")["200"]["content"]["application/json"]["schema"]
    assert listed["items"] == {"$ref": "#/components/schemas/PaymentMethodOut"}
