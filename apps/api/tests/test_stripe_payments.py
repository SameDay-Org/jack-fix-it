"""The Stripe payments wrapper (D11.1, #58): what it sends through the official SDK, what it
reads back, and how Stripe's failures come out. A recording HTTP client stands in for the
network; nothing here reaches Stripe."""

import logging
import uuid
from typing import Any
from urllib.parse import parse_qs

import pytest
import stripe
from starlette.requests import Request

from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_payments import (
    PAYMENT_INTENT_CLOSED_STATUSES,
    PAYMENT_INTENT_SEARCH_LIMIT,
    CardFacts,
    PaymentIntentFacts,
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
CANCEL_KEY = f"payment_intent_cancel:{PAYMENT_ID}"
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


async def test_cancel_payment_intent_sends_one_idempotent_abandoned_cancel() -> None:
    wrapper, http = client((200, intent_body(status="canceled")))

    canceled = await wrapper.cancel_payment_intent(INTENT, idempotency_key=CANCEL_KEY)

    assert canceled is True
    [(method, url, headers, form)] = http.sent
    assert (method, url) == ("post", f"https://api.stripe.com/v1/payment_intents/{INTENT}/cancel")
    assert headers["Idempotency-Key"] == CANCEL_KEY
    assert form == {"cancellation_reason": ["abandoned"]}


async def test_cancel_of_an_intent_stripe_cannot_cancel_is_false() -> None:
    """Processing, succeeded or canceled already: Stripe's unexpected_state is an answer."""
    wrapper, _ = client(
        (
            400,
            error_body(
                "payment_intent_unexpected_state",
                f"You cannot cancel this PaymentIntent ({INTENT}) because it has a status of "
                "succeeded.",
            ),
        )
    )

    assert await wrapper.cancel_payment_intent(INTENT, idempotency_key=CANCEL_KEY) is False


@pytest.mark.parametrize(
    ("answer", "kind", "code"),
    [
        (NETWORK_ERROR, StripeUnavailableError, None),
        ((503, {"error": {"type": "api_error", "message": "down"}}), StripeUnavailableError, None),
        (
            (404, error_body("resource_missing", f"No such payment_intent: '{INTENT}'")),
            StripeRejectedError,
            "resource_missing",
        ),
        # The code alone makes it an answer: another status with it is still an error.
        (
            (409, error_body("payment_intent_unexpected_state", "a concurrent request")),
            StripeUnavailableError,
            "payment_intent_unexpected_state",
        ),
    ],
)
async def test_cancel_errors_are_typed(
    answer: Answer, kind: type[Exception], code: str | None
) -> None:
    wrapper, _ = client(answer)

    with pytest.raises(kind) as caught:
        await wrapper.cancel_payment_intent(INTENT, idempotency_key=CANCEL_KEY)

    assert caught.value.code == code  # type: ignore[attr-defined]  # a StripeCallError
    assert INTENT not in repr(caught.value)


def search_body(*intents: dict[str, Any], has_more: bool = False) -> dict[str, Any]:
    return {
        "object": "search_result",
        "url": "/v1/payment_intents/search",
        "data": list(intents),
        "has_more": has_more,
        "next_page": "page_fixture" if has_more else None,
    }


async def test_search_payment_intents_queries_the_payment_id_and_reads_the_facts() -> None:
    other = intent_body(id="pi_fixture_other", amount=1, customer=None, metadata={})
    wrapper, http = client((200, search_body(intent_body(), other)))

    found = await wrapper.search_payment_intents(uuid.UUID(PAYMENT_ID))

    assert found.complete
    assert found.intents == (
        PaymentIntentFacts(INTENT, 10_000, "usd", CUSTOMER, PAYMENT_ID),
        PaymentIntentFacts("pi_fixture_other", 1, "usd", None, None),
    )
    [(method, url, headers, form)] = http.sent
    path, _, query = url.partition("?")
    assert (method, path) == ("get", "https://api.stripe.com/v1/payment_intents/search")
    assert parse_qs(query) == {
        "query": [f"metadata['payment_id']:'{PAYMENT_ID}'"],
        "limit": [str(PAYMENT_INTENT_SEARCH_LIMIT)],
    }
    assert "Idempotency-Key" not in headers
    assert form == {}


async def test_search_with_another_page_is_incomplete() -> None:
    wrapper, _ = client((200, search_body(intent_body(), has_more=True)))

    found = await wrapper.search_payment_intents(uuid.UUID(PAYMENT_ID))

    assert not found.complete
    assert len(found.intents) == 1


async def test_payment_intent_facts_reads_an_expanded_customer_too() -> None:
    expanded = intent_body(customer={"id": CUSTOMER, "object": "customer"}, client_secret=None)
    wrapper, http = client((200, expanded))

    facts = await wrapper.payment_intent_facts(INTENT)

    assert facts == PaymentIntentFacts(INTENT, 10_000, "usd", CUSTOMER, PAYMENT_ID)
    [(method, url, _, _)] = http.sent
    assert (method, url) == ("get", f"https://api.stripe.com/v1/payment_intents/{INTENT}")


@pytest.mark.parametrize(
    ("answer", "kind"),
    [
        (NETWORK_ERROR, StripeUnavailableError),
        ((429, error_body("rate_limit", "Too many requests")), StripeUnavailableError),
        ((400, error_body("search_unavailable", f"bad {PAYMENT_ID}")), StripeRejectedError),
    ],
)
async def test_search_and_facts_errors_are_typed(answer: Answer, kind: type[Exception]) -> None:
    wrapper, _ = client(answer, answer)

    with pytest.raises(kind) as searching:
        await wrapper.search_payment_intents(uuid.UUID(PAYMENT_ID))
    with pytest.raises(kind) as reading:
        await wrapper.payment_intent_facts(INTENT)

    assert str(searching.value) == str(reading.value) == kind.__name__


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


SESSION_SECRET = "cuss_secret_fixture0123abc"
# Exactly what the sheet may do with the saved cards (#253c), as the SDK encodes it: Stripe's
# server refuses removal and the "save this card" box, and the sheet lists every card the wallet
# lists.
SESSION_FORM = {
    "customer": [CUSTOMER],
    "components[mobile_payment_element][enabled]": ["true"],
    "components[mobile_payment_element][features][payment_method_remove]": ["disabled"],
    "components[mobile_payment_element][features][payment_method_redisplay]": ["enabled"],
    "components[mobile_payment_element][features][payment_method_allow_redisplay_filters][0]": [
        "always"
    ],
    "components[mobile_payment_element][features][payment_method_allow_redisplay_filters][1]": [
        "limited"
    ],
    "components[mobile_payment_element][features][payment_method_allow_redisplay_filters][2]": [
        "unspecified"
    ],
    "components[mobile_payment_element][features][payment_method_save]": ["disabled"],
}


def session_body(**overrides: Any) -> dict[str, Any]:
    return {
        "object": "customer_session",
        "client_secret": SESSION_SECRET,
        "customer": CUSTOMER,
        "expires_at": 1_900_000_000,
        "livemode": False,
        **overrides,
    }


async def test_create_customer_session_sends_exactly_the_sheet_features() -> None:
    wrapper, http = client((200, session_body()))

    secret = await wrapper.create_customer_session(CUSTOMER)

    assert secret == SESSION_SECRET
    [(method, url, _headers, form)] = http.sent
    assert (method, url) == ("post", "https://api.stripe.com/v1/customer_sessions")
    assert form == SESSION_FORM
    # No component but the mobile one: the session grants nothing else.
    assert not {key for key in form if key.startswith("components[")} - {
        key for key in SESSION_FORM if key.startswith("components[mobile_payment_element]")
    }


@pytest.mark.parametrize("body", [{"client_secret": None}, {"client_secret": ...}])
async def test_customer_session_without_secret_is_rejected(body: dict[str, Any]) -> None:
    answer = session_body(**body)
    if answer["client_secret"] is ...:
        del answer["client_secret"]
    wrapper, _ = client((200, answer))

    with pytest.raises(StripeRejectedError) as caught:
        await wrapper.create_customer_session(CUSTOMER)

    assert (caught.value.code, caught.value.request_id) == (
        "customer_session_no_secret",
        REQUEST_ID,
    )


@pytest.mark.parametrize(
    ("answer", "kind"),
    [
        (NETWORK_ERROR, StripeUnavailableError),
        ((429, error_body("rate_limit", "Too many requests")), StripeUnavailableError),
        (
            (400, error_body("parameter_unknown", f"Unknown parameter for {CUSTOMER}")),
            StripeRejectedError,
        ),
    ],
)
async def test_a_customer_session_failure_is_typed_and_carries_no_text(
    answer: Answer, kind: type[Exception]
) -> None:
    wrapper, _ = client(answer)

    with pytest.raises(kind) as caught:
        await wrapper.create_customer_session(CUSTOMER)

    assert str(caught.value) == kind.__name__
    assert CUSTOMER not in repr(caught.value)
    assert caught.value.__cause__ is None


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


def charged(card: dict[str, Any] | None) -> dict[str, Any]:
    """A succeeded intent with its latest charge expanded, paid with `card` (None: no card)."""
    details: dict[str, Any] = {"type": "card", "card": card} if card is not None else {"type": "x"}
    charge = {"id": "ch_test62", "object": "charge", "payment_method_details": details}
    return intent_body(status="succeeded", latest_charge=charge)


async def test_card_of_reads_the_expanded_charge_s_card_and_nothing_else() -> None:
    card = {
        "brand": "visa",
        "last4": "4242",
        "exp_month": 12,
        "exp_year": 2034,
        "fingerprint": "fp_secret",
        "wallet": {"type": "apple_pay", "apple_pay": {}},
    }
    wrapper, http = client((200, charged(card)))

    found = await wrapper.card_of(INTENT)

    assert found == CardFacts(brand="visa", last4="4242", wallet="apple_pay")
    [(method, url, _, form)] = http.sent
    # The charge is asked for expanded, in the query of the GET.
    assert (method, url) == (
        "get",
        f"https://api.stripe.com/v1/payment_intents/{INTENT}?expand[0]=latest_charge",
    )
    assert form == {}


@pytest.mark.parametrize(
    ("card", "expected"),
    [
        (None, None),
        (
            {"brand": "mastercard", "last4": "5555", "wallet": None},
            CardFacts("mastercard", "5555", None),
        ),
        # Anything not a 4-digit string is no last 4.
        ({"brand": "visa", "last4": "42", "wallet": None}, CardFacts("visa", None, None)),
    ],
)
async def test_card_of_reads_what_is_there_and_never_fails_on_what_is_not(
    card: dict[str, Any] | None, expected: CardFacts | None
) -> None:
    wrapper, _ = client((200, charged(card)))

    assert await wrapper.card_of(INTENT) == expected


async def test_card_of_an_intent_without_a_charge_is_none() -> None:
    wrapper, _ = client((200, intent_body(status="requires_payment_method", latest_charge=None)))

    assert await wrapper.card_of(INTENT) is None


def tip_charged(charge: object) -> dict[str, Any]:
    """A succeeded tip intent (#273 PR A2) with `charge` as its latest charge."""
    metadata = {"kind": "tip", "tip_id": "tip-1", "job_id": "job-1", "attempt": "1"}
    return intent_body(status="succeeded", latest_charge=charge, metadata=metadata)


def a_charge(**fields: Any) -> dict[str, Any]:
    return {
        "id": "ch_test273",
        "object": "charge",
        "refunded": False,
        "amount_refunded": 0,
        "disputed": False,
        **fields,
    }


@pytest.mark.parametrize(
    ("charge", "expected"),
    [
        (a_charge(), ("ch_test273", False, False)),
        (a_charge(amount_refunded=1), ("ch_test273", True, False)),
        (a_charge(refunded=True, amount_refunded=10_000), ("ch_test273", True, False)),
        (a_charge(disputed=True), ("ch_test273", False, True)),
        # Not expanded, or none: no charge to pay from.
        ("ch_test273", (None, False, False)),
        (None, (None, False, False)),
    ],
)
async def test_tip_charge_reads_the_expanded_charge_and_the_intent(
    charge: object, expected: tuple[str | None, bool, bool]
) -> None:
    wrapper, http = client((200, tip_charged(charge)))

    found = await wrapper.tip_charge(INTENT)

    assert (found.charge_id, found.refunded, found.disputed) == expected
    assert (found.intent.kind, found.intent.tip_id, found.intent.attempt, found.intent.status) == (
        "tip",
        "tip-1",
        "1",
        "succeeded",
    )
    [(method, url, _, _)] = http.sent
    assert (method, url) == (
        "get",
        f"https://api.stripe.com/v1/payment_intents/{INTENT}?expand[0]=latest_charge",
    )
