"""#96 skeptic repro (#523): unbounded-body-before-limits, moved into the suite.

The secure behaviour: a request body past a set cap is refused with 413 after the app has read
at most about that cap, before any dependency (auth, rate limit) runs. These tests drive the
app as raw ASGI with a counting `receive`, so the bytes the app pulled are measured exactly.
"""

import asyncio
from collections.abc import AsyncIterator

from fastapi import FastAPI
from starlette.types import Message

from app.db import get_session
from app.rate_limit import RateLimitResult, get_rate_limiter
from tests.conftest import make_app, make_settings

MIB = 1024 * 1024
CHUNKS = 64  # 64 MiB of body
# A generous bound over the app's cap (HTTP_MAX_BODY_BYTES): 1 MiB plus one in-flight chunk.
ALLOWED_TO_READ = 1 * MIB + MIB


class DenyAll:
    """Every rate-limit hit is over the limit: the request should never get past the limiter."""

    async def hit(
        self, scope: str, identifier: str, *, limit: int, window_seconds: int
    ) -> RateLimitResult:
        return RateLimitResult(allowed=False, retry_after_seconds=60)


async def drive(app: FastAPI, path: str) -> tuple[int, int]:
    """POSTs a valid JSON body of about 64 MiB to `path`; returns (status, bytes the app read)."""
    prefix = b'{"email":"a@example.com","password":"'
    filler = b"a" * MIB
    suffix = b'"}'
    parts = [prefix, *([filler] * CHUNKS), suffix]
    total = sum(len(p) for p in parts)
    consumed = 0
    index = 0
    done = asyncio.Event()
    status: list[int] = []

    async def receive() -> Message:
        nonlocal consumed, index
        if index < len(parts):
            part = parts[index]
            index += 1
            consumed += len(part)
            return {"type": "http.request", "body": part, "more_body": index < len(parts)}
        await done.wait()
        return {"type": "http.disconnect"}

    async def send(message: Message) -> None:
        if message["type"] == "http.response.start":
            status.append(message["status"])
        if message["type"] == "http.response.body" and not message.get("more_body", False):
            done.set()

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
        "headers": [
            (b"host", b"testserver"),
            (b"content-type", b"application/json"),
            (b"content-length", str(total).encode()),
        ],
        "client": ("203.0.113.7", 50000),
        "server": ("testserver", 80),
    }
    await asyncio.wait_for(app(scope, receive, send), timeout=120)
    return status[0], consumed


def deny_all_app() -> FastAPI:
    app = make_app(make_settings())
    limiter = DenyAll()
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    app.dependency_overrides[get_session] = _no_session
    return app


async def _no_session() -> AsyncIterator[None]:
    # No database: the requests must be refused (413) before any query runs.
    yield None


async def test_login_refuses_an_oversized_body_before_buffering_it() -> None:
    status, consumed = await drive(deny_all_app(), "/v1/auth/login")
    assert consumed <= ALLOWED_TO_READ, (
        f"unauthenticated, rate-limited POST /v1/auth/login: the app read {consumed} bytes "
        f"({consumed // MIB} MiB) of body before answering {status}"
    )
    assert status == 413


async def test_signed_in_route_refuses_an_oversized_body_before_auth() -> None:
    status, consumed = await drive(deny_all_app(), "/v1/addresses")
    assert consumed <= ALLOWED_TO_READ, (
        f"POST /v1/addresses with no token: the app read {consumed} bytes "
        f"({consumed // MIB} MiB) of body before answering {status}"
    )
    assert status == 413
