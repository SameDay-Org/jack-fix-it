"""Request id propagation plus one structured access log line per request."""

import logging
import re
import time
import uuid

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.observability import request_id_var

REQUEST_ID_HEADER = "X-Request-ID"
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
