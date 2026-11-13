"""Request id propagation plus one structured access log line per request, and the
`Cache-Control: no-store` of the routes whose responses no HTTP cache may keep."""

import logging
import re
import time
import uuid

from fastapi.routing import APIRoute
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.observability import request_id_var

REQUEST_ID_HEADER = "X-Request-ID"
CACHE_CONTROL_HEADER = "Cache-Control"
# Not `private` or `no-cache`: those still let a cache store the response (RFC 9111 5.2.2).
NO_STORE = "no-store"
# Incoming ids are echoed into logs and headers, so only accept short, safe tokens.
_VALID_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

logger = logging.getLogger("app.access")


def _incoming_request_id(scope: Scope) -> str | None:
    value = Headers(scope=scope).get(REQUEST_ID_HEADER)
    if value is not None and _VALID_REQUEST_ID.fullmatch(value):
        return value
    return None


class RequestIdMiddleware:
    """Reuses a valid X-Request-ID or generates one; adds it to the response and to every log line.

    The id is also stored in scope["state"] so the 500 handler, which runs outside this
    middleware, can still return it.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = _incoming_request_id(scope) or uuid.uuid4().hex
        scope.setdefault("state", {})["request_id"] = request_id
        token = request_id_var.set(request_id)
        status_code = 500
        started = time.perf_counter()

        async def send_with_request_id(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                MutableHeaders(scope=message)[REQUEST_ID_HEADER] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_with_request_id)
        finally:
            # Path only: query strings can carry PII.
            logger.info(
                "request",
                extra={
                    "request_id": request_id,
                    "method": scope["method"],
                    "path": scope["path"],
                    "status": status_code,
                    "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                },
            )
            request_id_var.reset(token)


class NoStoreRoute(APIRoute):
    """A route whose responses must not outlive the request in any HTTP cache, the client's
    own included: every one of them, errors too, says `Cache-Control: no-store`. Use it as a
    router's `route_class`."""


def is_no_store(scope: Scope) -> bool:
    """Whether the request was routed to a NoStoreRoute (the router records its match)."""
    return isinstance(scope.get("route"), NoStoreRoute)


class NoStoreMiddleware:
    """Adds `Cache-Control: no-store` to what a NoStoreRoute answers: its own response and the
    errors the app's handlers answer for it (401, 403, 404, 409, 422, 429, 503). The generic
    500 is built outside every middleware, so its handler adds the header (app/errors.py)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_no_store(message: Message) -> None:
            # Read when the response starts: the route is matched after this middleware runs.
            if message["type"] == "http.response.start" and is_no_store(scope):
                MutableHeaders(scope=message)[CACHE_CONTROL_HEADER] = NO_STORE
            await send(message)

        await self.app(scope, receive, send_no_store)
