"""The Stripe saved-cards wrapper (#253): what it sends through the official SDK, what it reads
back, and how Stripe's failures come out. A recording HTTP client stands in for the network;
nothing here reaches Stripe."""

import logging
from typing import Any

import pytest
import stripe
from starlette.requests import Request

from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_payment_methods import (
    PAYMENT_METHOD_PAGE_SIZE,
    CreatedSetupIntent,
    SavedCard,
    StripePaymentMethodsClient,
    get_stripe_payment_methods,
)
from app.observability import configure_logging
from tests.conftest import make_app, make_settings
from tests.test_stripe_connect import (
    FAKE_KEY,
    NETWORK_ERROR,
    REQUEST_ID,
    Answer,
    RecordingHTTPClient,
)

# Fixture values only: ids and secrets that name nothing real.
CUSTOMER = "cus_fixture0123456789"
OTHER_CUSTOMER = "cus_fixture9876543210"
METHOD = "pm_fixture0123456789"
SETUP_INTENT = "seti_fixture0123456789"
CLIENT_SECRET = f"{SETUP_INTENT}_secret_fixtureabc"
CREATED = 1_790_000_000
# What Stripe returns of a card and the wallet must never pass on.
FINGERPRINT = "Xt5EWLLDS7FJjR1c"
POSTAL_CODE = "32801-0042"
CARD = SavedCard(
    payment_method_id=METHOD,
    customer_id=CUSTOMER,
    brand="visa",
    last4="4242",
    exp_month=12,
    exp_year=2030,
    created=CREATED,
)


def client(*answers: Answer) -> tuple[StripePaymentMethodsClient, RecordingHTTPClient]:
    http = RecordingHTTPClient(*answers)
    wrapper = StripePaymentMethodsClient(
        secret_key=FAKE_KEY, timeout_seconds=5.0, max_network_retries=0, http_client=http
    )
    return wrapper, http


def method_body(**overrides: Any) -> dict[str, Any]:
    """A card PaymentMethod as Stripe answers it, with what the wallet never shows."""
    body: dict[str, Any] = {
        "id": METHOD,
        "object": "payment_method",
        "type": "card",
        "customer": CUSTOMER,
        "created": CREATED,
        "billing_details": {
            "name": "Ana Fixture",
            "email": "ana@example.invalid",
            "address": {"postal_code": POSTAL_CODE},
        },
        "card": {
            "brand": "visa",
            "last4": "4242",
            "exp_month": 12,
            "exp_year": 2030,
            "fingerprint": FINGERPRINT,
            "country": "US",
            "funding": "credit",
            "checks": {"cvc_check": "pass"},
            "wallet": None,
        },
    }
    body.update(overrides)
    return body


def error_body(code: str, message: str) -> dict[str, Any]:
    return {"error": {"type": "invalid_request_error", "code": code, "message": message}}


@pytest.fixture(autouse=True)
def app_logging() -> None:
    """LOG_LEVEL=DEBUG as create_app applies it. The SDK names every request URL (customer and
    PaymentMethod ids) at INFO and request bodies at DEBUG; the app keeps its logger at
    WARNING."""
    configure_logging("DEBUG")
    assert logging.getLogger("stripe").getEffectiveLevel() == logging.WARNING


async def test_setup_intent_saves_a_card_on_the_customer_on_session() -> None:
    answer: Answer = (
        200,
        {"id": SETUP_INTENT, "object": "setup_intent", "client_secret": CLIENT_SECRET},
    )
    wrapper, http = client(answer, answer)

    created = await wrapper.create_setup_intent(CUSTOMER)
    await wrapper.create_setup_intent(CUSTOMER)

    assert created == CreatedSetupIntent(client_secret=CLIENT_SECRET, request_id=REQUEST_ID)
    (method, url, headers, form), (_, _, again, _) = http.sent
    assert (method, url) == ("post", "https://api.stripe.com/v1/setup_intents")
    # Cards only, charged only with the customer present; nothing confirmed on the server.
    assert form == {
        "customer": [CUSTOMER],
        "allowed_payment_method_types[0]": ["card"],
        "usage": ["on_session"],
    }
    # A new SetupIntent per call (a replayed one may be completed already): no key of ours,
    # only the SDK's random one, new on each call.
    assert headers["Idempotency-Key"] != again["Idempotency-Key"]
    # The secret never shows in a repr (a log line, a traceback).
    assert CLIENT_SECRET not in repr(created)


async def test_setup_intent_without_a_secret_is_a_refusal() -> None:
    wrapper, _ = client((200, {"id": SETUP_INTENT, "object": "setup_intent"}))

    with pytest.raises(StripeRejectedError) as caught:
        await wrapper.create_setup_intent(CUSTOMER)

    assert caught.value.code == "setup_intent_no_secret"


async def test_list_asks_for_the_customers_cards_and_keeps_the_wallet_fields_only() -> None:
    older = method_body(id="pm_fixtureolder", created=CREATED - 60)
    bank = {"id": "pm_fixturebank", "object": "payment_method", "type": "us_bank_account"}
    wrapper, http = client(
        (200, {"object": "list", "data": [method_body(), older, bank], "has_more": False})
    )

    cards = await wrapper.list_cards(CUSTOMER)

    assert cards == (
        CARD,
        SavedCard(
            payment_method_id="pm_fixtureolder",
            customer_id=CUSTOMER,
            brand="visa",
            last4="4242",
            exp_month=12,
            exp_year=2030,
            created=CREATED - 60,
        ),
    )
    [(method, url, _, _)] = http.sent
    assert method == "get"
    assert url == (
        "https://api.stripe.com/v1/payment_methods"
        f"?customer={CUSTOMER}&type=card&limit={PAYMENT_METHOD_PAGE_SIZE}"
    )
    # Nothing else of a PaymentMethod leaves the wrapper.
    for card in cards:
        assert FINGERPRINT not in repr(card)
        assert POSTAL_CODE not in repr(card)
        assert "Ana Fixture" not in repr(card)


async def test_retrieve_reads_the_card_and_who_it_is_attached_to() -> None:
    expanded = method_body(customer={"id": OTHER_CUSTOMER, "object": "customer"})
    wrapper, http = client((200, method_body()), (200, expanded), (200, method_body(customer=None)))

    own = await wrapper.retrieve_card(METHOD)
    others = await wrapper.retrieve_card(METHOD)
    detached = await wrapper.retrieve_card(METHOD)

    assert own == CARD
    assert others is not None
    assert others.customer_id == OTHER_CUSTOMER
    assert detached is not None
    assert detached.customer_id is None
    assert {(method, url) for method, url, _, _ in http.sent} == {
        ("get", f"https://api.stripe.com/v1/payment_methods/{METHOD}")
    }


async def test_retrieve_answers_none_for_an_unknown_id_or_another_type() -> None:
    missing = error_body("resource_missing", f"No such PaymentMethod: '{METHOD}'")
    bank = {"id": METHOD, "object": "payment_method", "type": "us_bank_account", "customer": None}
    wrapper, _ = client((404, missing), (200, bank))

    assert await wrapper.retrieve_card(METHOD) is None
    assert await wrapper.retrieve_card(METHOD) is None


@pytest.mark.parametrize(
    ("customer", "expected"),
    [
        ({"invoice_settings": {"default_payment_method": METHOD}}, METHOD),
        ({"invoice_settings": {"default_payment_method": {"id": METHOD, "object": "x"}}}, METHOD),
        ({"invoice_settings": {"default_payment_method": None}}, None),
        ({"deleted": True}, None),
    ],
    ids=["id", "expanded", "none", "deleted-customer"],
)
async def test_default_payment_method_reads_the_customers_setting(
    customer: dict[str, Any], expected: str | None
) -> None:
    wrapper, http = client((200, {"id": CUSTOMER, "object": "customer", **customer}))

    assert await wrapper.default_payment_method(CUSTOMER) == expected
    [(method, url, _, _)] = http.sent
    assert (method, url) == ("get", f"https://api.stripe.com/v1/customers/{CUSTOMER}")


async def test_set_default_updates_the_customers_setting_only() -> None:
    answer: Answer = (200, {"id": CUSTOMER, "object": "customer"})
    wrapper, http = client(answer, answer)

    await wrapper.set_default_payment_method(CUSTOMER, METHOD)
    await wrapper.set_default_payment_method(CUSTOMER, METHOD)

    (method, url, headers, form), (_, _, again, _) = http.sent
    assert (method, url) == ("post", f"https://api.stripe.com/v1/customers/{CUSTOMER}")
    assert form == {"invoice_settings[default_payment_method]": [METHOD]}
    # No key of ours (only the SDK's random one): a replayed "A is the default" would skip a
    # later A after B.
    assert headers["Idempotency-Key"] != again["Idempotency-Key"]


async def test_detach_detaches_the_payment_method() -> None:
    wrapper, http = client((200, method_body(customer=None)))

    await wrapper.detach(METHOD)

    [(method, url, _, form)] = http.sent
    assert (method, url) == ("post", f"https://api.stripe.com/v1/payment_methods/{METHOD}/detach")
    assert form == {}


CALLS = {
    "create_setup_intent": lambda w: w.create_setup_intent(CUSTOMER),
    "list_cards": lambda w: w.list_cards(CUSTOMER),
    "retrieve_card": lambda w: w.retrieve_card(METHOD),
    "default_payment_method": lambda w: w.default_payment_method(CUSTOMER),
    "set_default_payment_method": lambda w: w.set_default_payment_method(CUSTOMER, METHOD),
    "detach": lambda w: w.detach(METHOD),
}


@pytest.mark.parametrize("call", sorted(CALLS))
@pytest.mark.parametrize(
    ("answer", "kind", "code"),
    [
        (NETWORK_ERROR, StripeUnavailableError, None),
        ((429, error_body("rate_limit", f"Too many requests for {CUSTOMER}")), None, None),
        ((500, error_body("api_error", f"Boom on {METHOD}")), StripeUnavailableError, None),
        (
            (400, error_body("resource_missing", f"No such customer: '{CUSTOMER}' / {METHOD}")),
            StripeRejectedError,
            "resource_missing",
        ),
    ],
    ids=["network", "429", "500", "400"],
)
async def test_failures_carry_the_request_id_and_code_never_stripes_text(
    call: str,
    answer: Answer,
    kind: type[Exception] | None,
    code: str | None,
    caplog: pytest.LogCaptureFixture,
) -> None:
    wrapper, http = client(answer)

    with (
        caplog.at_level(logging.DEBUG),
        pytest.raises((StripeUnavailableError, StripeRejectedError)) as caught,
    ):
        await CALLS[call](wrapper)

    assert type(caught.value) is (kind or StripeUnavailableError)
    if code is not None:
        assert caught.value.code == code
    # One request, no retry; the error is not chained and its text names nothing.
    assert len(http.sent) == 1
    assert caught.value.__cause__ is None
    assert caught.value.__suppress_context__
    assert CUSTOMER not in str(caught.value)
    assert METHOD not in str(caught.value)
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert CUSTOMER not in logged
    assert METHOD not in logged


def test_dependency_builds_one_client_per_app_and_none_without_a_key() -> None:
    configured = make_app(make_settings(stripe_secret_key=FAKE_KEY))
    scope = {"type": "http", "app": configured}
    first = get_stripe_payment_methods(Request(scope))
    assert isinstance(first, StripePaymentMethodsClient)
    assert get_stripe_payment_methods(Request(scope)) is first

    bare = make_app(make_settings(stripe_secret_key=None))
    assert get_stripe_payment_methods(Request({"type": "http", "app": bare})) is None
    with pytest.raises(RuntimeError, match="STRIPE_SECRET_KEY"):
        StripePaymentMethodsClient.from_settings(make_settings(stripe_secret_key=None))


def test_stripe_error_classes_used_by_the_fixtures_exist() -> None:
    """The network fixture is the SDK's own connection error: a rename would silently turn
    the unavailable case into a different path."""
    assert isinstance(NETWORK_ERROR, stripe.APIConnectionError)
