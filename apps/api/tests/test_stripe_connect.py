"""The Stripe Connect wrapper (D7.1, #39): what it sends through the official SDK, what it reads
back, and how Stripe's failures come out. A recording HTTP client stands in for the network,
except in the opt-in live smoke test (D7.5)."""

import json
import logging
import os
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
import stripe
from fastapi import FastAPI

from app.integrations.stripe_connect import (
    AccountState,
    ProfileAccounts,
    StripeExpressConnect,
    StripeRejectedError,
    StripeUnavailableError,
    get_stripe_connect,
)
from app.observability import configure_logging
from tests.conftest import make_app, make_settings

# Fixture values only: not a key (nothing here reaches Stripe), ids that name nothing real.
FAKE_KEY = "sk_test_fixture-not-a-real-key"
ACCOUNT = "acct_fixture0123456789"
PROFILE = "3f0c6a2e-1111-4222-8333-444455556666"
KEY = f"pro-express-account:{PROFILE}"
EMAIL = "pro-fixture@example.invalid"
LINK_URL = f"https://connect.stripe.com/setup/e/{ACCOUNT}/fixture"
EXPIRES_AT = 1_767_225_600  # 2026-01-01T00:00:00Z
REQUEST_ID = "req_fixture123"

Answer = tuple[int, dict[str, Any]] | Exception
# What the SDK's httpx client raises on a timeout or a network failure.
NETWORK_ERROR = stripe.APIConnectionError(  # type: ignore[no-untyped-call]  # untyped SDK __init__
    "Network error: a ReadTimeout was raised"
)


class RecordingHTTPClient(stripe.HTTPClient):
    """Answers each async request with the next canned answer and records what was sent.
    Synchronous requests fail: the wrapper must never make one."""

    name = "recording"

    def __init__(self, *answers: Answer) -> None:
        super().__init__()
        self.answers = list(answers)
        self.sent: list[tuple[str, str, dict[str, str], dict[str, list[str]]]] = []

    async def request_async(
        self, method: str, url: str, headers: Mapping[str, str], post_data: Any = None
    ) -> tuple[bytes, int, Mapping[str, str]]:
        form = parse_qs(post_data or "", keep_blank_values=True)
        self.sent.append((method, url, dict(headers), form))
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        status, body = answer
        return json.dumps(body).encode(), status, {"request-id": REQUEST_ID}

    def request(self, *args: Any, **kwargs: Any) -> Any:  # pragma: no cover - must not happen
        raise AssertionError("synchronous Stripe call")

    def request_stream(self, *args: Any, **kwargs: Any) -> Any:  # pragma: no cover
        raise AssertionError("synchronous Stripe call")

    def close(self) -> None:
        pass

    async def close_async(self) -> None:
        pass

    async def sleep_async(self, secs: float) -> None:
        pass


def connect(
    *answers: Answer, max_pages: int = 3
) -> tuple[StripeExpressConnect, RecordingHTTPClient]:
    http = RecordingHTTPClient(*answers)
    wrapper = StripeExpressConnect(
        secret_key=FAKE_KEY,
        timeout_seconds=5.0,
        max_network_retries=0,
        account_list_max_pages=max_pages,
        http_client=http,
    )
    return wrapper, http


def error_body(code: str, message: str = f"No such account: '{ACCOUNT}'") -> dict[str, Any]:
    return {"error": {"type": "invalid_request_error", "code": code, "message": message}}


@pytest.fixture(autouse=True)
def app_logging() -> None:
    """LOG_LEVEL=DEBUG as create_app applies it. The SDK names every request URL (account ids)
    at INFO and request bodies (emails) at DEBUG; the app keeps its logger at WARNING."""
    configure_logging("DEBUG")
    assert logging.getLogger("stripe").getEffectiveLevel() == logging.WARNING


async def test_create_express_account_sends_one_idempotent_create() -> None:
    wrapper, http = connect((200, {"id": ACCOUNT, "object": "account"}))

    created = await wrapper.create_express_account(
        email=EMAIL, profile_id=PROFILE, idempotency_key=KEY
    )

    assert (created.account_id, created.request_id) == (ACCOUNT, REQUEST_ID)
    [(method, url, headers, form)] = http.sent
    assert (method, url) == ("post", "https://api.stripe.com/v1/accounts")
    assert headers["Idempotency-Key"] == KEY
    assert headers["Authorization"] == f"Bearer {FAKE_KEY}"
    assert form == {
        "type": ["express"],
        "country": ["US"],
        "email": [EMAIL],
        "capabilities[transfers][requested]": ["true"],
        "metadata[pro_profile_id]": [PROFILE],
    }


async def test_create_onboarding_link() -> None:
    wrapper, http = connect(
        (200, {"object": "account_link", "url": LINK_URL, "expires_at": EXPIRES_AT})
    )

    link = await wrapper.create_onboarding_link(
        ACCOUNT, return_url="https://api.example.invalid/r", refresh_url="https://x.invalid/f"
    )

    assert link.url == LINK_URL
    assert link.expires_at == datetime(2026, 1, 1, tzinfo=UTC)
    [(method, url, _, form)] = http.sent
    assert (method, url) == ("post", "https://api.stripe.com/v1/account_links")
    assert form == {
        "account": [ACCOUNT],
        "type": ["account_onboarding"],
        "return_url": ["https://api.example.invalid/r"],
        "refresh_url": ["https://x.invalid/f"],
    }


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        (
            {"details_submitted": False, "payouts_enabled": False, "requirements": None},
            AccountState(details_submitted=False, payouts_enabled=False, requirements_due=False),
        ),
        (
            {
                "details_submitted": True,
                "payouts_enabled": False,
                "requirements": {"currently_due": ["external_account"]},
            },
            AccountState(details_submitted=True, payouts_enabled=False, requirements_due=True),
        ),
        (
            {
                "details_submitted": True,
                "payouts_enabled": True,
                "requirements": {"currently_due": []},
            },
            AccountState(details_submitted=True, payouts_enabled=True, requirements_due=False),
        ),
    ],
)
async def test_retrieve_account(body: dict[str, Any], expected: AccountState) -> None:
    wrapper, http = connect((200, {"id": ACCOUNT, "object": "account", **body}))

    assert await wrapper.retrieve_account(ACCOUNT) == expected
    [(method, url, _, _)] = http.sent
    assert (method, url) == ("get", f"https://api.stripe.com/v1/accounts/{ACCOUNT}")


@pytest.mark.parametrize(
    ("answer", "kind", "code"),
    [
        (NETWORK_ERROR, "unavailable", None),
        ((500, error_body("api_error", "Internal")), "unavailable", "api_error"),
        ((503, error_body("api_error", "Unavailable")), "unavailable", "api_error"),
        ((429, error_body("rate_limit", "Too many")), "unavailable", "rate_limit"),
        ((409, error_body("lock_timeout", "Locked")), "unavailable", "lock_timeout"),
        ((404, error_body("resource_missing")), "rejected", "resource_missing"),
        ((400, error_body("idempotency_key_in_use", "Keys")), "rejected", None),
        ((401, error_body("api_key_expired", "Expired")), "rejected", "api_key_expired"),
        ((403, error_body("platform_api_key_expired", "No")), "rejected", None),
    ],
)
async def test_errors_are_typed_and_carry_no_text(answer: Answer, kind: str, code: str) -> None:
    wrapper, _ = connect(answer)
    expected = StripeUnavailableError if kind == "unavailable" else StripeRejectedError

    with pytest.raises(expected) as raised:
        await wrapper.retrieve_account(ACCOUNT)

    error = raised.value
    if code is not None:
        assert error.code == code
    if not isinstance(answer, Exception):
        assert error.request_id == REQUEST_ID
    # Stripe's message names the account: it is neither in the text nor chained.
    assert ACCOUNT not in str(error)
    assert ACCOUNT not in repr(error)
    assert error.__cause__ is None
    assert error.__suppress_context__


async def test_errors_on_create_and_link_are_typed() -> None:
    wrapper, _ = connect(
        (400, error_body("email_invalid", f"Invalid email: {EMAIL}")),
        (404, error_body("resource_missing")),
    )

    with pytest.raises(StripeRejectedError) as on_create:
        await wrapper.create_express_account(email=EMAIL, profile_id=PROFILE, idempotency_key=KEY)
    with pytest.raises(StripeRejectedError) as on_link:
        await wrapper.create_onboarding_link(
            ACCOUNT, return_url="https://a", refresh_url="https://b"
        )

    assert (on_create.value.code, on_link.value.code) == ("email_invalid", "resource_missing")
    assert EMAIL not in str(on_create.value)


def accounts_page(*metadata: dict[str, str] | None, has_more: bool) -> tuple[int, dict[str, Any]]:
    """One page of GET /v1/accounts: an account per entry, with that metadata."""
    data = [
        {"id": f"acct_page{uuid.uuid4().hex[:10]}", "object": "account", "metadata": entry}
        for entry in metadata
    ]
    return 200, {"object": "list", "url": "/v1/accounts", "data": data, "has_more": has_more}


def list_queries(http: RecordingHTTPClient) -> list[dict[str, list[str]]]:
    assert all(
        (method, urlsplit(url).path) == ("get", "/v1/accounts") for method, url, *_ in http.sent
    )
    return [parse_qs(urlsplit(url).query) for _, url, _, _ in http.sent]


async def test_find_accounts_by_profile_reads_every_page_and_filters_metadata() -> None:
    mine = {"pro_profile_id": PROFILE}
    first = accounts_page(None, {}, {"pro_profile_id": str(uuid.uuid4())}, has_more=True)
    second = accounts_page({"other": "x"}, mine, has_more=False)
    wrapper, http = connect(first, second)

    found = await wrapper.find_accounts_by_profile(PROFILE)

    assert found == ProfileAccounts((second[1]["data"][1]["id"],), complete=True)
    assert list_queries(http) == [
        {"limit": ["100"]},
        {"limit": ["100"], "starting_after": [first[1]["data"][-1]["id"]]},
    ]


async def test_find_accounts_by_profile_stops_at_the_page_bound() -> None:
    mine = {"pro_profile_id": PROFILE}
    wrapper, http = connect(
        accounts_page(mine, has_more=True), accounts_page({}, has_more=True), max_pages=2
    )

    found = await wrapper.find_accounts_by_profile(PROFILE)

    assert (len(found.account_ids), found.complete) == (1, False)
    assert len(http.sent) == 2


async def test_find_accounts_by_profile_stops_at_a_second_match() -> None:
    mine = {"pro_profile_id": PROFILE}
    wrapper, http = connect(accounts_page(mine, has_more=True), accounts_page(mine, has_more=True))

    found = await wrapper.find_accounts_by_profile(PROFILE)

    assert (len(found.account_ids), found.complete) == (2, False)
    assert len(http.sent) == 2


async def test_find_accounts_by_profile_errors_are_typed() -> None:
    wrapper, _ = connect(accounts_page({}, has_more=True), NETWORK_ERROR)

    with pytest.raises(StripeUnavailableError):
        await wrapper.find_accounts_by_profile(PROFILE)


@pytest.mark.parametrize(
    ("metadata", "expected"),
    [({"pro_profile_id": PROFILE, "other": "x"}, PROFILE), ({"other": "x"}, None), (None, None)],
)
async def test_account_profile_id_reads_the_metadata(
    metadata: dict[str, str] | None, expected: str | None
) -> None:
    """Staff recovery (#279): the profile an account's metadata names, read from the account."""
    wrapper, http = connect((200, {"id": ACCOUNT, "object": "account", "metadata": metadata}))

    assert await wrapper.account_profile_id(ACCOUNT) == expected
    [(method, url, _, _)] = http.sent
    assert (method, url) == ("get", f"https://api.stripe.com/v1/accounts/{ACCOUNT}")


@pytest.mark.parametrize(
    ("answer", "kind"),
    [
        ((404, error_body("resource_missing")), StripeRejectedError),
        (NETWORK_ERROR, StripeUnavailableError),
    ],
)
async def test_account_profile_id_errors_are_typed(answer: Answer, kind: type[Exception]) -> None:
    wrapper, _ = connect(answer)

    with pytest.raises(kind) as raised:
        await wrapper.account_profile_id(ACCOUNT)
    assert ACCOUNT not in str(raised.value)


def test_get_stripe_connect_needs_the_key() -> None:
    without = make_app(make_settings(stripe_secret_key=None))
    with_key = make_app(make_settings(stripe_secret_key=FAKE_KEY))

    assert get_stripe_connect(_request(without)) is None
    built = get_stripe_connect(_request(with_key))
    assert isinstance(built, StripeExpressConnect)
    assert get_stripe_connect(_request(with_key)) is built  # one per app
    with pytest.raises(RuntimeError, match="STRIPE_SECRET_KEY"):
        StripeExpressConnect.from_settings(make_settings(stripe_secret_key=None))


def _request(app: FastAPI) -> Any:
    class AppRequest:
        pass

    request = AppRequest()
    request.app = app  # type: ignore[attr-defined]
    return request


# The live smoke test (D7.5). Opt-in only: pyproject's addopts deselect the marker, so CI never
# runs it; `uv run pytest -m stripe_live tests/test_stripe_connect.py` with a test-mode key in
# STRIPE_SECRET_KEY does. It creates a real test-mode Express account and deletes it after.


@pytest.mark.stripe_live
async def test_stripe_live_smoke() -> None:
    key = os.environ.get("STRIPE_SECRET_KEY", "")
    if not key:
        pytest.skip("STRIPE_SECRET_KEY is not set")
    if not key.startswith("sk_test_"):
        pytest.fail("refusing to run: STRIPE_SECRET_KEY is not a test-mode key (sk_test_)")
    wrapper = StripeExpressConnect.from_settings(make_settings(stripe_secret_key=key))
    run = uuid.uuid4()
    account = dict(
        email=f"smoke-{run.hex[:12]}@example.com",
        profile_id=str(run),
        idempotency_key=f"jack-smoke:{run}",
    )
    created = await wrapper.create_express_account(**account)
    try:
        link = await wrapper.create_onboarding_link(
            created.account_id,
            return_url="https://example.com/v1/payouts/onboarding/return",
            refresh_url="https://example.com/v1/payouts/onboarding/refresh",
        )
        assert urlsplit(link.url).hostname == "connect.stripe.com"
        assert link.expires_at > datetime.now(UTC)
        state = await wrapper.retrieve_account(created.account_id)
        assert state == AccountState(
            details_submitted=False, payouts_enabled=False, requirements_due=True
        )
        # The same key gives the same account back: a retry never makes a second one.
        again = await wrapper.create_express_account(**account)
        assert again.account_id == created.account_id
    finally:
        cleanup = stripe.StripeClient(key, http_client=stripe.HTTPXClient(timeout=10.0))
        await cleanup.v1.accounts.delete_async(created.account_id)
