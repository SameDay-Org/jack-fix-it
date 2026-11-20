"""The request body cap (#523): every body is refused with 413 past HTTP_MAX_BODY_BYTES, before
the app buffers it.

FastAPI reads and parses a JSON body before it solves a route's dependencies, so this has to
sit on the ASGI stream, outside the routing: a declared Content-Length over the cap is refused
before a byte is read, and an undeclared (chunked) or understated body is cut off as soon as the
running count passes the cap. A few raw-body routes (the Stripe webhooks) get their own cap by
path. The app's own answer to the aborted read (FastAPI turns it into a 400) is dropped and the
413 sent in its place.
"""

from collections.abc import Mapping

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.errors import PayloadTooLargeError, error_response


class _BodyTooLargeError(Exception):
    """Raised from `receive` to stop whatever is reading the body."""


async def _refuse(scope: Scope, receive: Receive, send: Send) -> None:
    error = PayloadTooLargeError()
    response = error_response(error.status_code, error.code, error.message)
    await response(scope, receive, send)


class BodySizeLimitMiddleware:
    def __init__(
        self, app: ASGIApp, *, max_bytes: int, max_bytes_by_path: Mapping[str, int]
    ) -> None:
        self.app = app
        self.max_bytes = max_bytes
        self.max_bytes_by_path = dict(max_bytes_by_path)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        limit = self.max_bytes_by_path.get(scope["path"], self.max_bytes)
        declared = Headers(scope=scope).get("content-length", "")
        if declared.isdigit() and int(declared) > limit:
            await _refuse(scope, receive, send)
            return

        received = 0
        exceeded = False
        started = False

        async def counted_receive() -> Message:
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    exceeded = True
                    raise _BodyTooLargeError
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal started
            if exceeded:
                return  # the app's answer to the aborted read; the 413 replaces it
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, counted_receive, guarded_send)
        except Exception:
            if not exceeded or started:
                raise
        if exceeded and not started:
            await _refuse(scope, receive, send)
