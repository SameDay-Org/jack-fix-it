"""The request body cap (#523, found by the #96 review).

FastAPI reads and parses a JSON body before it solves any dependency, so without a cap an
anonymous client could make the API buffer and parse any size before auth or a rate limit ran.
The cap is enforced on the ASGI stream: a declared Content-Length over it is refused before a
byte is read, and an undeclared (chunked) or understated body is cut off as soon as the count
passes it. These tests drive the app as raw ASGI with a counting `receive`, so the bytes the
app pulled are measured exactly.
"""

import asyncio
from collections.abc import AsyncIterator

import pytest
from fastapi import FastAPI
from pydantic import ValidationError
from starlette.types import Message

from app.config import Settings
from app.db import get_session
from app.queue import get_job_queue
from app.rate_limit import RateLimitResult, get_rate_limiter
from tests.conftest import make_app, make_settings

KIB = 1024
CAP = 64 * KIB
CHUNK = 16 * KIB


class DenyAll:
    """Every rate-limit hit is over the limit: a request that reached a limiter answers 429."""

    async def hit(
        self, scope: str, identifier: str, *, limit: int, window_seconds: int
    ) -> RateLimitResult:
        return RateLimitResult(allowed=False, retry_after_seconds=60)


async def _no_session() -> AsyncIterator[None]:
    # No database: a refused request never gets as far as a query.
    yield None


def offline_app(settings: Settings) -> FastAPI:
    """No database, no queue, and every rate limit denied."""
    app = make_app(settings)
    limiter = DenyAll()
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    app.dependency_overrides[get_session] = _no_session
    app.dependency_overrides[get_job_queue] = lambda: None
    return app


def capped_app() -> FastAPI:
    return offline_app(make_settings(http_max_body_bytes=CAP))


class Answer:
    def __init__(self) -> None:
        self.status = 0
        self.headers: dict[str, str] = {}
        self.body = b""
        self.read = 0  # body bytes the app pulled from `receive`


async def drive(
    app: FastAPI,
    path: str,
    size: int,
    *,
    declared: int | None = -1,
    headers: list[tuple[bytes, bytes]] | None = None,
) -> Answer:
    """POSTs a JSON body of `size` bytes to `path` in CHUNK-sized messages. `declared` is the
    Content-Length sent: -1 for the true size, None for none (chunked)."""
    body = b'{"email":"a@example.com","password":"' + b"a" * max(size - 40, 0) + b'"}'
    body = body[:size].ljust(size, b" ")
    parts = [body[i : i + CHUNK] for i in range(0, len(body), CHUNK)] or [b""]
    answer = Answer()
    done = asyncio.Event()
    index = 0

    async def receive() -> Message:
        nonlocal index
        if index < len(parts):
            part = parts[index]
            index += 1
            answer.read += len(part)
            return {"type": "http.request", "body": part, "more_body": index < len(parts)}
        await done.wait()
        return {"type": "http.disconnect"}

    async def send(message: Message) -> None:
        if message["type"] == "http.response.start":
            answer.status = message["status"]
            answer.headers = {k.decode().lower(): v.decode() for k, v in message["headers"]}
        elif message["type"] == "http.response.body":
            answer.body += message.get("body", b"")
            if not message.get("more_body", False):
                done.set()

    sent_headers = [(b"host", b"testserver"), (b"content-type", b"application/json")]
    if declared is not None:
        length = size if declared == -1 else declared
        sent_headers.append((b"content-length", str(length).encode()))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": sent_headers + (headers or []),
        "client": ("203.0.113.7", 50000),
        "server": ("testserver", 80),
    }
    await asyncio.wait_for(app(scope, receive, send), timeout=60)
    return answer


def assert_payload_too_large(answer: Answer) -> None:
    assert answer.status == 413, answer.body
    assert answer.body == (
        b'{"error":{"code":"payload_too_large","message":"The body is too large."}}'
    )


async def test_a_declared_body_over_the_cap_is_refused_before_a_byte_is_read() -> None:
    """Login is rate limited per IP (here every hit is denied): the cap answers first."""
    answer = await drive(capped_app(), "/v1/auth/login", CAP + 1)

    assert_payload_too_large(answer)
    assert answer.read == 0


async def test_a_chunked_body_over_the_cap_is_cut_off_at_the_cap() -> None:
    answer = await drive(capped_app(), "/v1/auth/login", 16 * CAP, declared=None)

    assert_payload_too_large(answer)
    assert answer.read <= CAP + CHUNK


async def test_an_understated_length_does_not_get_past_the_cap() -> None:
    answer = await drive(capped_app(), "/v1/auth/login", 16 * CAP, declared=100)

    assert_payload_too_large(answer)
    assert answer.read <= CAP + CHUNK


async def test_a_signed_in_route_refuses_an_oversized_body_before_auth() -> None:
    """No token: without the cap this is a 401 after the whole body was parsed."""
    chunked = await drive(capped_app(), "/v1/addresses", 16 * CAP, declared=None)
    declared = await drive(capped_app(), "/v1/addresses", CAP + 1)

    assert_payload_too_large(chunked)
    assert chunked.read <= CAP + CHUNK
    assert_payload_too_large(declared)
    assert declared.read == 0


@pytest.mark.parametrize("declared", [-1, None], ids=["declared", "chunked"])
async def test_a_body_at_the_cap_goes_through(declared: int | None) -> None:
    answer = await drive(capped_app(), "/v1/addresses", CAP, declared=declared)

    assert answer.status == 401
    assert answer.read == CAP


async def test_the_refusal_carries_the_request_id() -> None:
    answer = await drive(
        capped_app(), "/v1/auth/login", CAP + 1, headers=[(b"x-request-id", b"cap-123")]
    )

    assert_payload_too_large(answer)
    assert answer.headers["x-request-id"] == "cap-123"


async def test_the_stripe_webhooks_keep_their_own_larger_cap() -> None:
    """The raw-body routes read up to STRIPE_WEBHOOK_MAX_BODY_BYTES (their own stream check
    still applies): a body between the two caps reaches the route (here 503, as no secret is
    set), and one past the webhook cap is refused before it is read."""
    settings = make_settings()
    between = (settings.http_max_body_bytes + settings.stripe_webhook_max_body_bytes) // 2
    assert settings.http_max_body_bytes < between < settings.stripe_webhook_max_body_bytes
    app = offline_app(settings)

    for path in ("/v1/webhooks/stripe", "/v1/webhooks/stripe/connect"):
        reached = await drive(app, path, between)
        refused = await drive(app, path, settings.stripe_webhook_max_body_bytes + 1)

        assert reached.status == 503, path
        assert_payload_too_large(refused)
        assert refused.read == 0


async def test_any_other_route_uses_the_general_cap() -> None:
    settings = make_settings()
    answer = await drive(offline_app(settings), "/v1/addresses", settings.http_max_body_bytes + 1)

    assert_payload_too_large(answer)


def test_the_cap_must_hold_the_largest_intake_answers() -> None:
    with pytest.raises(ValidationError, match="HTTP_MAX_BODY_BYTES"):
        make_settings(http_max_body_bytes=1_000, request_intake_max_bytes=2_000)
