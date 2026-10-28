"""Query strings never reach Sentry: they can carry emails or tokens (#119)."""

import json
import logging
import random
import re
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
from tests.helpers import seconds_without_gc

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


@pytest.mark.parametrize("header_name", ["Referer", "referer", "REFERER"])
@pytest.mark.parametrize(
    ("referer", "expected"),
    [
        (f"https://app.example.invalid/login?{QUERY}", "https://app.example.invalid/login"),
        (f"/login?{QUERY}", "/login"),
        (f"login?{QUERY}", "login"),
        (f"?{QUERY}", ""),
    ],
    ids=["absolute", "absolute_path", "path_relative", "query_only"],
)
def test_before_send_strips_query_from_any_referer_form(
    header_name: str, referer: str, expected: str
) -> None:
    # Other headers keep their current handling: a value that is not URL-like stays.
    event: Any = {"request": {"headers": {header_name: referer, "user-agent": "probe/1.0?beta"}}}

    result = before_send(event, {})

    assert result["request"]["headers"] == {header_name: expected, "user-agent": "probe/1.0?beta"}


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
        # The forms reproduced in review round 2.
        (f'fetch "/v1/x?{QUERY}" failed', 'fetch "/v1/x failed'),
        (f"fetch '/v1/x?{QUERY}' failed", "fetch '/v1/x failed"),
        (f"retry (/v1/x?{QUERY}) later", "retry (/v1/x later"),
        (f"request_path=/v1/jobs?{QUERY} status=500", "request_path=/v1/jobs status=500"),
        ("[http://x/y?q=1]", "[http://x/y"),
        ("<https://x?y>", "<https://x"),
        ("see https://x/p?q=1, then", "see https://x/p then"),
        ("{/v1/x?q=1}", "{/v1/x"),
        ("at:/v1/x?q=1;also", "at:/v1/x"),
        # The query runs to whitespace, so separators inside it cannot keep a part.
        ("/v1/x?email=a@b.c,token=abc123;id=(1)", "/v1/x"),
        # A question mark in ordinary words is not a query.
        ("is this a question? yes", "is this a question? yes"),
        ("ordinary?question what?", "ordinary?question what?"),
        ("query?a=1 a/b?c", "query?a=1 a/b?c"),
    ],
    ids=[
        "quoted",
        "assignment",
        "parenthesized",
        "double_quoted_path",
        "single_quoted_path",
        "parenthesized_path",
        "request_path",
        "bracketed_url",
        "angle_bracketed_url",
        "url_then_comma",
        "braced_path",
        "colon_path",
        "separators_in_query",
        "plain_question",
        "words_with_question_marks",
        "not_at_a_boundary",
    ],
)
def test_before_breadcrumb_message_url_boundaries(message: str, expected: str) -> None:
    assert before_breadcrumb({"type": "log", "message": message}, {})["message"] == expected


# The breadcrumb-message regex before review round 1. It backtracked quadratically on some long
# messages, but on short ones it is a precise oracle for which characters are scrubbed.
OLD_MESSAGE_REGEX = re.compile(r"(?<![^\s\"'(<=])((?:[A-Za-z][A-Za-z0-9+.-]*://|/)[^\s?]*)\?\S*")
# The one intended difference: a URL may also start after [ { : , ; (review round 2).
OLD_MESSAGE_REGEX_WIDER_START = re.compile(
    r"(?<![^\s\"'(\[<{=:,;])((?:[A-Za-z][A-Za-z0-9+.-]*://|/)[^\s?]*)\?\S*"
)
DIFFERENTIAL_ALPHABET = "/?=:\"'()[]<>,; aAz.&-@{}"


def test_before_breadcrumb_message_matches_old_regex() -> None:
    rng = random.Random(1234)  # noqa: S311 - seeded test inputs, not secrets
    messages = [
        "".join(rng.choice(DIFFERENTIAL_ALPHABET) for _ in range(rng.randint(0, 40)))
        for _ in range(5_000)
    ]
    without_new_starts = 0

    for message in messages:
        scrubbed = before_breadcrumb({"type": "log", "message": message}, {})["message"]
        assert scrubbed == OLD_MESSAGE_REGEX_WIDER_START.sub(r"\1", message), message
        # Where none of the added start boundaries occurs, the old regex itself agrees.
        if not set("[{:,;") & set(message):
            without_new_starts += 1
            assert scrubbed == OLD_MESSAGE_REGEX.sub(r"\1", message), message

    assert without_new_starts > 500


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
    # Every other character is a start boundary, followed by a scheme candidate or a path.
    "assignment_run": lambda n: ("a=" * (n // 2) + "?",) * 2,
    "colon_scheme_candidates": lambda n: (":ab" * (n // 3) + "?",) * 2,
    "quoted_paths": lambda n: ('"/' * (n // 2) + "?x", '"/' * (n // 2)),
}


@pytest.mark.parametrize("kind", ADVERSARIAL_MESSAGES)
def test_before_breadcrumb_message_adversarial_inputs(kind: str) -> None:
    message, expected = ADVERSARIAL_MESSAGES[kind](4_000)

    assert before_breadcrumb({"type": "log", "message": message}, {})["message"] == expected


@pytest.mark.parametrize("kind", ADVERSARIAL_MESSAGES)
def test_before_breadcrumb_message_scrub_scales_linearly(kind: str) -> None:
    # The hook runs on every log record. The quadratic regex took minutes at this size.
    message, _ = ADVERSARIAL_MESSAGES[kind](256_000)

    seconds = seconds_without_gc(lambda: before_breadcrumb({"type": "log", "message": message}, {}))

    assert seconds < 1


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


@pytest.mark.parametrize(
    ("referer", "expected"),
    [(f"login?{QUERY}", "login"), (f"?{QUERY}", "")],
    ids=["path_relative", "query_only"],
)
async def test_captured_event_relative_referer_has_no_query(
    sentry_transport: MemoryTransport, referer: str, expected: str
) -> None:
    app = create_app(make_settings(sentry_dsn=TEST_DSN))

    @app.get("/v1/test-sentry-referer-probe")
    async def probe() -> None:
        raise RuntimeError("probe failure")

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/v1/test-sentry-referer-probe", headers={"Referer": referer})
    sentry_sdk.flush()

    assert response.status_code == 500
    payloads = _payloads(sentry_transport)
    events = [json.loads(p) for p in payloads if '"exception"' in p]
    assert events, "no event was captured"
    wire = "\n".join(payloads)
    for leak in LEAKS:
        assert leak not in wire
    for event in events:
        assert event["request"]["headers"]["referer"] == expected


async def test_captured_log_breadcrumb_with_quoted_relative_url_has_no_query(
    sentry_transport: MemoryTransport,
) -> None:
    app = create_app(make_settings(sentry_dsn=TEST_DSN))

    @app.get("/v1/test-sentry-quoted-probe")
    async def probe() -> None:
        # How a library logs: %-style arguments, and a URL in `extra`.
        logging.getLogger("some.library").warning(
            'calling "%s" failed',
            f"/v1/lookup?{QUERY}",
            extra={"request_path": f"/v1/lookup?{QUERY}"},
        )
        raise RuntimeError("probe failure")

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        assert (await client.get("/v1/test-sentry-quoted-probe")).status_code == 500
    sentry_sdk.flush()

    payloads = _payloads(sentry_transport)
    events = [json.loads(p) for p in payloads if '"exception"' in p]
    assert events, "no event was captured"
    wire = "\n".join(payloads)
    for leak in LEAKS:
        assert leak not in wire
    for event in events:
        [crumb] = [c for c in event["breadcrumbs"]["values"] if c["category"] == "some.library"]
        assert crumb["message"] == 'calling "/v1/lookup failed'
        assert crumb["data"]["request_path"] == "/v1/lookup"


def test_before_breadcrumb_strips_url_query_from_data_text() -> None:
    crumb: dict[str, Any] = {
        "type": "log",
        "message": "request",
        "data": {"request_path": f"/v1/jobs?{QUERY}", "count": 3, "note": "why? because"},
    }

    assert before_breadcrumb(crumb, {})["data"] == {
        "request_path": "/v1/jobs",
        "count": 3,
        "note": "why? because",
    }


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
