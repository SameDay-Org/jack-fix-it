"""Calls the web app's server makes on a visitor's behalf (#409; the #86 spec's part A).

The browser never calls these routes: the web app's server does, after its own checks (a signed
form token, a honeypot). It proves who it is with `X-JFI-Web-Key` = WEB_SERVICE_KEY, compared in
constant time; anyone else gets 401 `invalid_service_key`. Only behind a valid key is its
`X-JFI-Client-IP` read: the visitor's address, as Railway's edge gave it to the web (one value,
a valid address), for the per-address limits. Without one, the limits fall back to the caller's
own address (`client_ip`: the socket's, which uvicorn rewrites from X-Forwarded-For only for
FORWARDED_ALLOW_IPS). A client's X-Forwarded-For is never read here.

The auth routes' per-IP limits count the same way (#530, `caller_ip`): the admin panel's login,
refresh and logout are called by the web's server, and counted by its one address every panel
visitor shared a bucket, so one anonymous script could lock the staff out and sign them out.

Two public routes the app and the web both call (the ZIP check and the waitlist join, #86) take
the forwarded address the same way, only behind a valid key (`caller_ip`), but never
refuse a call without one: the app's own calls count against their socket address.

Logs name the refusal only: never a key, an address or a header's value.
"""

import hmac
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated, Final

from fastapi import Depends
from pydantic import SecretStr
from starlette.requests import Request

from app.config import Settings, get_app_settings
from app.errors import AppError
from app.rate_limit import RateLimiter, client_ip, enforce_limit, get_rate_limiter, normalized_ip

logger = logging.getLogger(__name__)

WEB_KEY_HEADER: Final = "x-jfi-web-key"
VISITOR_IP_HEADER: Final = "x-jfi-client-ip"


class InvalidServiceKeyError(AppError):
    """A call without the web service's key, or with another one."""

    status_code = 401
    code = "invalid_service_key"
    message = "This endpoint takes calls from the Jack Fix It web service only."


@dataclass(frozen=True)
class WebCaller:
    """A call the web service made. `visitor_ip`: the visitor's address it forwarded, or its
    own when it forwarded none."""

    visitor_ip: str


def key_matches(given: str | None, expected: SecretStr | None) -> bool:
    """Whether the header's key is the configured one, in constant time. No key configured:
    nobody is the web service."""
    if given is None or expected is None:
        return False
    return hmac.compare_digest(given.encode(), expected.get_secret_value().encode())


def visitor_ip(request: Request) -> str | None:
    """The one X-JFI-Client-IP value when it is a valid address (normalised: an IPv4-mapped
    IPv6 address is the IPv4 one); None for none, several, or anything else."""
    values = request.headers.getlist(VISITOR_IP_HEADER)
    if len(values) != 1:
        return None
    return normalized_ip(values[0].strip())


async def require_web_service(
    request: Request, settings: Annotated[Settings, Depends(get_app_settings)]
) -> WebCaller:
    """FastAPI dependency: the web service's call, or 401 (see the module doc)."""
    if not key_matches(request.headers.get(WEB_KEY_HEADER), settings.web_service_key):
        logger.warning("web_service_key_refused")
        raise InvalidServiceKeyError
    return WebCaller(visitor_ip=visitor_ip(request) or client_ip(request))


WebService = Annotated[WebCaller, Depends(require_web_service)]


def caller_ip(request: Request, settings: Settings) -> str:
    """The address a per-IP limit counts (#530). Behind the web service's key, the visitor's it
    forwarded (X-JFI-Client-IP); its own address when it forwarded none, logged, as that is
    the one bucket every visitor would share. Without the key, or with another one, the
    caller's own address (client_ip): the header is not read."""
    if not key_matches(request.headers.get(WEB_KEY_HEADER), settings.web_service_key):
        return client_ip(request)
    visitor = visitor_ip(request)
    if visitor is None:
        logger.warning("web_service_visitor_ip_missing")
        return client_ip(request)
    return visitor


def limit_per_caller_ip(scope: str) -> Callable[..., Awaitable[None]]:
    """A dependency allowing AUTH_RATE_LIMIT_REQUESTS per caller_ip per window on one route:
    rate_limit.limit_per_ip, for the routes the web's server calls on a visitor's behalf (the
    auth routes, #530; the ZIP check, #86)."""

    async def dependency(
        request: Request,
        limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
        settings: Annotated[Settings, Depends(get_app_settings)],
    ) -> None:
        await enforce_limit(
            limiter,
            scope,
            caller_ip(request, settings),
            limit=settings.auth_rate_limit_requests,
            window_seconds=settings.auth_rate_limit_window_seconds,
            timeout_seconds=settings.rate_limit_timeout_seconds,
        )

    return dependency
