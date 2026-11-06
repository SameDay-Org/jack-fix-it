"""The Stripe payments wrapper (D11.1, #58): what it sends through the official SDK, what it
reads back, and how Stripe's failures come out. A recording HTTP client stands in for the
network; nothing here reaches Stripe."""

import logging
from typing import Any

import pytest
import stripe
from starlette.requests import Request

from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_payments import (
    PAYMENT_INTENT_CLOSED_STATUSES,
    PaymentIntentState,
    StripePaymentsClient,
    get_stripe_payments,
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
INTENT = "pi_fixture0123456789"
CLIENT_SECRET = f"{INTENT}_secret_fixtureabc"
EPHEMERAL_SECRET = "ek_test_fixture_secret0123"
USER_ID = "7d2f9a3e-1111-4222-8333-444455556666"
PAYMENT_ID = "0c1d2e3f-aaaa-4bbb-8ccc-dddeeefff000"
QUOTE_ID = "1a2b3c4d-bbbb-4ccc-8ddd-eeefff000111"
SERVICE_REQUEST_ID = "2b3c4d5e-cccc-4ddd-8eee-fff000111222"
CUSTOMER_KEY = f"customer:{USER_ID}"
INTENT_KEY = f"payment_intent:{PAYMENT_ID}"
TRANSFER_GROUP = f"request:{SERVICE_REQUEST_ID}"
METADATA = {"payment_id": PAYMENT_ID, "quote_id": QUOTE_ID, "request_id": SERVICE_REQUEST_ID}
# What a PaymentIntent create must never carry: a capture to confirm later (ADR 0006), a
# destination or a settlement merchant (ADR 0005), a fee, or a confirmation on the server.
FORBIDDEN_PARAMS = {
    "capture_method",
    "transfer_data[destination]",
    "transfer_data[amount]",
    "on_behalf_of",
    "application_fee_amount",
    "confirm",
    "payment_method",
}


def client(*answers: Answer) -> tuple[StripePaymentsClient, RecordingHTTPClient]:
    http = RecordingHTTPClient(*answers)
    wrapper = StripePaymentsClient(
        secret_key=FAKE_KEY, timeout_seconds=5.0, max_network_retries=0, http_client=http
    )
    return wrapper, http


def intent_body(status: str = "requires_payment_method", **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": INTENT,
        "object": "payment_intent",
        "client_secret": CLIENT_SECRET,
        "status": status,
        "amount": 10_000,
        "currency": "usd",
        "customer": CUSTOMER,
        "transfer_group": TRANSFER_GROUP,
        "metadata": METADATA,
    }
    body.update(overrides)
    return body


def error_body(code: str, message: str) -> dict[str, Any]:
    return {"error": {"type": "invalid_request_error", "code": code, "message": message}}


async def create_intent(wrapper: StripePaymentsClient) -> PaymentIntentState:
    return await wrapper.create_payment_intent(
        amount_cents=10_000,
        currency="usd",
        customer_id=CUSTOMER,
        transfer_group=TRANSFER_GROUP,
        metadata=METADATA,
        idempotency_key=INTENT_KEY,
    )


@pytest.fixture(autouse=True)
def app_logging() -> None:
    """LOG_LEVEL=DEBUG as create_app applies it. The SDK names every request URL (customer and
    PaymentIntent ids) at INFO and request bodies at DEBUG; the app keeps its logger at
    WARNING."""
    configure_logging("DEBUG")
    assert logging.getLogger("stripe").getEffectiveLevel() == logging.WARNING


async def test_create_customer_sends_one_idempotent_create_without_pii() -> None:
    wrapper, http = client((200, {"id": CUSTOMER, "object": "customer"}))

    created = await wrapper.create_customer(user_id=USER_ID, idempotency_key=CUSTOMER_KEY)

    assert (created.customer_id, created.request_id) == (CUSTOMER, REQUEST_ID)
    [(method, url, headers, form)] = http.sent
    assert (method, url) == ("post", "https://api.stripe.com/v1/customers")
    assert headers["Idempotency-Key"] == CUSTOMER_KEY
    # The user id only: no email, no name, no phone.
    assert form == {"metadata[user_id]": [USER_ID]}


async def test_payment_intent_parameters() -> None:
    wrapper, http = client((200, intent_body()))

    state = await create_intent(wrapper)

    assert state == PaymentIntentState(
        payment_intent_id=INTENT,
        client_secret=CLIENT_SECRET,
        status="requires_payment_method",
        request_id=REQUEST_ID,
    )
    [(method, url, headers, form)] = http.sent
    assert (method, url) == ("post", "https://api.stripe.com/v1/payment_intents")
    assert headers["Idempotency-Key"] == INTENT_KEY
    assert form == {
        "amount": ["10000"],
        "currency": ["usd"],
        "customer": [CUSTOMER],
        # Card, Apple Pay and Google Pay: the Dashboard's methods, minus redirect-based ones.
        "automatic_payment_methods[enabled]": ["true"],
        "automatic_payment_methods[allow_redirects]": ["never"],
        "transfer_group": [TRANSFER_GROUP],
        "metadata[payment_id]": [PAYMENT_ID],
        "metadata[quote_id]": [QUOTE_ID],
        "metadata[request_id]": [SERVICE_REQUEST_ID],
    }
    # Automatic capture, the platform's own charge, no fee: none of these is sent.
    assert not FORBIDDEN_PARAMS & set(form)


async def test_retrieve_payment_intent_reads_the_status() -> None:
    wrapper, http = client((200, intent_body(status="succeeded")))

    state = await wrapper.retrieve_payment_intent(INTENT)

    assert state.status == "succeeded"
    assert state.status in PAYMENT_INTENT_CLOSED_STATUSES
    assert (state.payment_intent_id, state.client_secret) == (INTENT, CLIENT_SECRET)
    [(method, url, _, form)] = http.sent
    assert (method, url) == ("get", f"https://api.stripe.com/v1/payment_intents/{INTENT}")
    assert form == {}


async def test_payment_intent_without_client_secret_is_rejected() -> None:
    wrapper, _ = client((200, intent_body(client_secret=None)))

    with pytest.raises(StripeRejectedError) as caught:
        await create_intent(wrapper)

    assert (caught.value.code, caught.value.request_id) == ("payment_intent_no_secret", REQUEST_ID)


async def test_create_ephemeral_key_sends_the_pinned_api_version() -> None:
    wrapper, http = client(
        (200, {"id": "ephkey_fixture", "object": "ephemeral_key", "secret": EPHEMERAL_SECRET})
    )

    secret = await wrapper.create_ephemeral_key(CUSTOMER)

    assert secret == EPHEMERAL_SECRET
    [(method, url, headers, form)] = http.sent
    assert (method, url) == ("post", "https://api.stripe.com/v1/ephemeral_keys")
    assert headers["Stripe-Version"] == stripe.api_version
    assert form == {"customer": [CUSTOMER]}


@pytest.mark.parametrize("body", [{"secret": None}, {}])
async def test_ephemeral_key_without_secret_is_rejected(body: dict[str, Any]) -> None:
    wrapper, _ = client((200, {"id": "ephkey_fixture", "object": "ephemeral_key", **body}))

    with pytest.raises(StripeRejectedError) as caught:
        await wrapper.create_ephemeral_key(CUSTOMER)

    assert caught.value.code == "ephemeral_key_no_secret"


@pytest.mark.parametrize(
    ("answer", "kind", "code"),
    [
        (NETWORK_ERROR, StripeUnavailableError, None),
        (
            (409, error_body("lock_timeout", "Another request holds the lock")),
            StripeUnavailableError,
            "lock_timeout",
        ),
        (
            (429, error_body("rate_limit", "Too many requests")),
            StripeUnavailableError,
            "rate_limit",
        ),
        (
            (503, {"error": {"type": "api_error", "message": "Stripe is down"}}),
            StripeUnavailableError,
            None,
        ),
        (
            (400, error_body("parameter_invalid_integer", f"Invalid integer for {CLIENT_SECRET}")),
            StripeRejectedError,
            "parameter_invalid_integer",
        ),
        (
            (404, error_body("resource_missing", f"No such payment_intent: '{INTENT}'")),
            StripeRejectedError,
            "resource_missing",
        ),
    ],
)
async def test_errors_are_typed_and_carry_no_text(
    answer: Answer, kind: type[Exception], code: str | None
) -> None:
    wrapper, _ = client(answer)

    with pytest.raises(kind) as caught:
        await wrapper.retrieve_payment_intent(INTENT)

    error = caught.value
    assert isinstance(error, kind)
    assert (error.code, error.__cause__) == (code, None)  # type: ignore[attr-defined]
    assert error.__suppress_context__  # raised from None: the SDK error is not shown
    assert error.request_id == (None if answer is NETWORK_ERROR else REQUEST_ID)  # type: ignore[attr-defined]
    # Never Stripe's message: it can name the PaymentIntent or carry the client secret.
    assert str(error) == kind.__name__
    assert INTENT not in repr(error)


def test_get_stripe_payments_builds_one_client_per_app_or_none_without_a_key() -> None:
    without_key = make_app(make_settings(stripe_secret_key=None))
    with_key = make_app(make_settings(stripe_secret_key=FAKE_KEY))

    def request_of(app: Any) -> Request:
        return Request({"type": "http", "app": app, "method": "GET", "path": "/", "headers": []})

    assert get_stripe_payments(request_of(without_key)) is None
    first = get_stripe_payments(request_of(with_key))
    assert isinstance(first, StripePaymentsClient)
    assert get_stripe_payments(request_of(with_key)) is first
    with pytest.raises(RuntimeError, match="STRIPE_SECRET_KEY"):
        StripePaymentsClient.from_settings(make_settings(stripe_secret_key=None))
