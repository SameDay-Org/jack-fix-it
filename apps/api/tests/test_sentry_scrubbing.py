"""Query strings never reach Sentry: they can carry emails or tokens (#119)."""

import json
import logging
import time
from collections.abc import Callable, Iterator
from typing import Any

import httpx
import pytest
import sentry_sdk
from sentry_sdk.envelope import Envelope
from sentry_sdk.transport import Transport

from app import observability
from app.main import create_app
from app.observability import JsonFormatter, before_breadcrumb, before_send, init_sentry
from tests.conftest import make_settings

# A dummy DSN: the in-memory transport below means nothing leaves the process.
TEST_DSN = "https://public@example.invalid/1"
QUERY = "email=probe@example.com&token=abc123"
LEAKS = ("probe@example.com", "probe%40example.com", "abc123", "email=")


class MemoryTransport(Transport):
    """Keeps every envelope the client would send."""

    def __init__(self) -> None:
        super().__init__()
        self.envelopes: list[Envelope] = []

    def capture_envelope(self, envelope: Envelope) -> None:
        self.envelopes.append(envelope)


@pytest.fixture
def sentry_transport(monkeypatch: pytest.MonkeyPatch) -> Iterator[MemoryTransport]:
    """Sentry initialized by init_sentry, sending to memory. Disabled again afterwards."""
    transport = MemoryTransport()
    real_init = sentry_sdk.init

    def init_with_memory_transport(*args: Any, **kwargs: Any) -> object:
        return real_init(*args, transport=transport, **kwargs)

    monkeypatch.setattr(sentry_sdk, "init", init_with_memory_transport)
    try:
        yield transport
    finally:
        sentry_sdk.get_client().close()
        sentry_sdk.get_global_scope().set_client(None)


def _payloads(transport: MemoryTransport) -> list[str]:
    """Every captured envelope item, as the JSON text that would go over the wire."""
    return [item.get_bytes().decode() for envelope in transport.envelopes for item in envelope]


def test_before_send_strips_query_string_and_url_query() -> None:
    event: Any = {
        "request": {
            "url": f"http://testserver/v1/jobs/42?{QUERY}",
            "query_string": QUERY,
            "method": "GET",
            "headers": {"host": "testserver"},
        },
        "transaction": "/v1/jobs/{job_id}",
        "level": "error",
    }

    result = before_send(event, {})

    assert result == {
        "request": {
            "url": "http://testserver/v1/jobs/42",
            "method": "GET",
            "headers": {"host": "testserver"},
        },
        "transaction": "/v1/jobs/{job_id}",
        "level": "error",
    }


def test_before_send_strips_referer_query() -> None:
    event: Any = {
        "request": {
            "url": "http://testserver/v1/auth/login",
            "headers": {
                "referer": f"https://app.example.invalid/login?{QUERY}",
                "user-agent": "probe/1.0",
            },
        },
    }

    result = before_send(event, {})

    assert result["request"]["headers"] == {
        "referer": "https://app.example.invalid/login",
        "user-agent": "probe/1.0",
    }


def test_before_send_strips_url_transaction_query() -> None:
    url_based = before_send({"transaction": f"/v1/unknown?{QUERY}"}, {})
    function_based = before_send({"transaction": "app.main.handler"}, {})

    assert url_based == {"transaction": "/v1/unknown"}
    assert function_based == {"transaction": "app.main.handler"}


@pytest.mark.parametrize(
    "event",
    [
        {"message": "no request", "level": "error"},
        {"request": None},
        {"request": "not a dict"},
        {"request": {"url": 42, "headers": ["not", "a", "dict"]}},
        {"transaction": None},
    ],
)
def test_before_send_tolerates_missing_request(event: Any) -> None:
    expected = json.loads(json.dumps(event))

    assert before_send(event, {}) == expected


def test_before_breadcrumb_strips_url_query() -> None:
    http: dict[str, Any] = {
        "type": "http",
        "category": "httplib",
        "data": {
            "url": f"https://partner.example.invalid/lookup?{QUERY}",
            "http.query": QUERY,
            "method": "GET",
            "status_code": 200,
        },
    }
    navigation: dict[str, Any] = {
        "type": "navigation",
        "data": {"url": f"/v1/jobs?{QUERY}", "from": "/v1/jobs"},
    }
    log: dict[str, Any] = {"type": "log", "category": "app.access", "message": "request"}

    assert before_breadcrumb(http, {}) == {
        "type": "http",
        "category": "httplib",
        "data": {
            "url": "https://partner.example.invalid/lookup",
            "method": "GET",
            "status_code": 200,
        },
    }
    assert before_breadcrumb(navigation, {}) == {
        "type": "navigation",
        "data": {"url": "/v1/jobs", "from": "/v1/jobs"},
    }
    assert before_breadcrumb(log, {}) == {
        "type": "log",
        "category": "app.access",
        "message": "request",
    }
    assert before_breadcrumb({"type": "http", "data": None}, {}) == {"type": "http", "data": None}


def test_before_breadcrumb_strips_url_query_from_log_message() -> None:
    crumb: dict[str, Any] = {
        "type": "log",
        "category": "some.library",
        "message": (
            f'HTTP Request: GET https://partner.example.invalid/lookup?{QUERY} "HTTP/1.1 200 OK"'
            f" then /v1/jobs?{QUERY} done"
        ),
        "level": "info",
    }

    assert before_breadcrumb(crumb, {}) == {
        "type": "log",
        "category": "some.library",
        "message": (
            'HTTP Request: GET https://partner.example.invalid/lookup "HTTP/1.1 200 OK"'
            " then /v1/jobs done"
        ),
        "level": "info",
    }
    plain = {"type": "log", "message": "is this a question? yes"}
    assert before_breadcrumb(dict(plain), {}) == plain


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        (f'calling "https://h.example.invalid/p?{QUERY}"', 'calling "https://h.example.invalid/p'),
        (f"url=https://h.example.invalid/p?{QUERY}", "url=https://h.example.invalid/p"),
        (f"(see /v1/jobs?{QUERY})", "(see /v1/jobs"),
        # A question mark in ordinary words is not a query.
        ("is this a question? yes", "is this a question? yes"),
    ],
    ids=["quoted", "assignment", "parenthesized", "plain_question"],
)
def test_before_breadcrumb_message_url_boundaries(message: str, expected: str) -> None:
    assert before_breadcrumb({"type": "log", "message": message}, {})["message"] == expected


# Inputs that made the earlier regex backtrack, by character count: (message, expected).
ADVERSARIAL_MESSAGES: dict[str, Callable[[int], tuple[str, str]]] = {
    "slash_equals": lambda n: ("/=" * (n // 2) + " ordinary?question",) * 2,
    "slash_equals_then_url": lambda n: (
        "/=" * (n // 2) + f" /v1/jobs?{QUERY} ordinary?question",
        "/=" * (n // 2) + " /v1/jobs ordinary?question",
    ),
    "slash_question": lambda n: ("/?" * (n // 2), "/"),
    "repeated_scheme": lambda n: ("http://" * (n // 7),) * 2,
    "plain_then_question": lambda n: ("a" * n + "?b",) * 2,
}


@pytest.mark.parametrize("kind", ADVERSARIAL_MESSAGES)
def test_before_breadcrumb_message_adversarial_inputs(kind: str) -> None:
    message, expected = ADVERSARIAL_MESSAGES[kind](4_000)

    assert before_breadcrumb({"type": "log", "message": message}, {})["message"] == expected


@pytest.mark.parametrize("kind", ADVERSARIAL_MESSAGES)
def test_before_breadcrumb_message_scrub_scales_linearly(kind: str) -> None:
    # The hook runs on every log record. The quadratic regex took minutes at this size.
    message, _ = ADVERSARIAL_MESSAGES[kind](256_000)

    started = time.perf_counter()
    before_breadcrumb({"type": "log", "message": message}, {})

    assert time.perf_counter() - started < 1


async def test_captured_event_contains_no_query_values(
    sentry_transport: MemoryTransport, caplog: pytest.LogCaptureFixture
) -> None:
    app = create_app(make_settings(sentry_dsn=TEST_DSN))

    @app.get("/v1/test-sentry-probe")
    async def probe() -> None:
        # An outgoing call records an http breadcrumb; MockTransport keeps it off the network.
        mock = httpx.MockTransport(lambda request: httpx.Response(200))
        async with httpx.AsyncClient(transport=mock) as client:
            await client.get(f"https://partner.example.invalid/lookup?{QUERY}")
        raise RuntimeError("probe failure")

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    with caplog.at_level(logging.DEBUG):
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get(
                f"/v1/test-sentry-probe?{QUERY}",
                headers={"Referer": f"https://app.example.invalid/login?{QUERY}"},
            )
    sentry_sdk.flush()

    assert response.status_code == 500
    payloads = _payloads(sentry_transport)
    events = [json.loads(p) for p in payloads if '"exception"' in p]
    assert events, "no event was captured"
    wire = "\n".join(payloads)
    for leak in LEAKS:
        assert leak not in wire
    # The scrubbed values are still there, without their query.
    for event in events:
        assert event["request"]["url"] == "http://testserver/v1/test-sentry-probe"
        assert "query_string" not in event["request"]
        assert event["request"]["headers"]["referer"] == "https://app.example.invalid/login"
        crumbs = event["breadcrumbs"]["values"]
        http_urls = [c["data"]["url"] for c in crumbs if c.get("type") == "http"]
        assert http_urls == ["https://partner.example.invalid/lookup"]
    # Nor do the logs: what stdout would print, and the raw messages.
    assert caplog.records
    formatter = JsonFormatter()
    logs = "\n".join(formatter.format(r) + r.getMessage() for r in caplog.records)
    for leak in LEAKS:
        assert leak not in logs


def test_sentry_disabled_without_dsn_still_holds(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(sentry_sdk, "init", lambda **kwargs: calls.append(kwargs))

    init_sentry(make_settings(sentry_dsn=None))
    assert calls == []

    init_sentry(make_settings(sentry_dsn=TEST_DSN))
    [options] = calls
    assert options["send_default_pii"] is False
    assert options["max_request_body_size"] == "never"
    assert options["include_local_variables"] is False
    assert options["before_send"] is observability.before_send
    assert options["before_breadcrumb"] is observability.before_breadcrumb
