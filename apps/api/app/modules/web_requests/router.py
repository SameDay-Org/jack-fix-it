import logging
import uuid
from collections.abc import Callable, Coroutine
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.integrations.storage import Storage, get_storage
from app.middleware import NoStoreRoute
from app.modules.addresses.service import AddressService
from app.modules.categories.service import CategoryService
from app.modules.requests.service import RequestConfig, ServiceRequestService
from app.modules.service_areas.service import ServiceAreaService
from app.modules.waitlist.service import WaitlistService
from app.modules.web_requests.errors import LengthRequiredError, WebRequestTooLargeError
from app.modules.web_requests.schemas import WebRequestCreated, WebRequestIn
from app.modules.web_requests.service import WebRequestService
from app.queue import JobQueue, get_job_queue
from app.rate_limit import (
    IdentifierHasher,
    RateLimiter,
    enforce_limit,
    get_identifier_hasher,
    get_rate_limiter,
)
from app.web_service import WEB_KEY_HEADER, InvalidServiceKeyError, WebService, key_matches

logger = logging.getLogger(__name__)


class WebServiceBodyRoute(NoStoreRoute):
    """A web-service route whose body is never read before the caller is the web service and
    the body's declared size is within WEB_REQUEST_MAX_BODY_BYTES (#86). FastAPI reads a body
    before any dependency runs, so both are checked here, ahead of it. The server holds the
    body to its Content-Length, so the declared size bounds what is read."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def checked(request: Request) -> Response:
            settings: Settings = request.app.state.settings
            if not key_matches(request.headers.get(WEB_KEY_HEADER), settings.web_service_key):
                logger.warning("web_service_key_refused")
                raise InvalidServiceKeyError
            declared = request.headers.get("content-length", "")
            if not declared.isdigit():
                raise LengthRequiredError
            if int(declared) > settings.web_request_max_body_bytes:
                raise WebRequestTooLargeError
            return await handler(request)

        return checked


router = APIRouter(prefix="/web/requests", tags=["web"], route_class=WebServiceBodyRoute)


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_web_request_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    storage: Annotated[Storage, Depends(get_storage)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    queue: Annotated[JobQueue, Depends(get_job_queue)],
) -> WebRequestService:
    service_areas = ServiceAreaService(session)
    categories = CategoryService(session)
    requests = ServiceRequestService(
        session,
        AddressService(session),
        categories,
        service_areas,
        storage,
        RequestConfig.from_settings(settings),
        queue,
    )
    waitlist = WaitlistService(
        session, service_areas, categories, settings.phone_allowed_country_codes
    )
    return WebRequestService(
        session, requests, service_areas, waitlist, settings.phone_allowed_country_codes
    )


async def limit_web_requests(
    # Same name and model as the route's body, so FastAPI parses the body once.
    data: WebRequestIn,
    caller: WebService,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    hasher: Annotated[IdentifierHasher, Depends(get_identifier_hasher)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """WEB_REQUEST_IP_LIMIT per visitor address (the one the web service forwarded), then
    WEB_REQUEST_EMAIL_LIMIT per email and WEB_REQUEST_PHONE_LIMIT per phone, per
    WEB_REQUEST_WINDOW_SECONDS; then WEB_REQUEST_DAILY_LIMIT per email and per phone per
    WEB_REQUEST_DAILY_WINDOW_SECONDS. A contact enters a key only as a keyed hash."""
    email, phone = hasher(data.contact.email), hasher(data.contact.phone)
    for scope, identifier, limit, window in (
        ("web_request_ip", caller.visitor_ip, settings.web_request_ip_limit, None),
        ("web_request_email", email, settings.web_request_email_limit, None),
        ("web_request_phone", phone, settings.web_request_phone_limit, None),
        ("web_request_email_day", email, settings.web_request_daily_limit, True),
        ("web_request_phone_day", phone, settings.web_request_daily_limit, True),
    ):
        await enforce_limit(
            limiter,
            scope,
            identifier,
            limit=limit,
            window_seconds=settings.web_request_daily_window_seconds
            if window
            else settings.web_request_window_seconds,
            timeout_seconds=settings.rate_limit_timeout_seconds,
        )


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=WebRequestCreated,
    summary="Make a request without an account (the web service only)",
    dependencies=[Depends(limit_web_requests)],
    responses={
        status.HTTP_201_CREATED: {
            "description": "Received: in the BDC's queue. The same answer for a replay of the "
            "same Idempotency-Key and body."
        },
        status.HTTP_401_UNAUTHORIZED: _error(
            "invalid_service_key: no X-JFI-Web-Key, or not the web service's (the body is "
            "never read)."
        ),
        status.HTTP_409_CONFLICT: _error(
            "out_of_area: the ZIP is not served; no request was made and the contact is on the "
            "ZIP's waitlist. idempotency_key_reused: the key already made a request with "
            "another body."
        ),
        411: _error("length_required: no Content-Length."),
        status.HTTP_413_CONTENT_TOO_LARGE: _error(
            "payload_too_large: the body is over WEB_REQUEST_MAX_BODY_BYTES."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: a bad field (as POST /v1/requests checks them), a phone "
            "outside the allowed country codes, an unknown field, or no Idempotency-Key; "
            "invalid_category / invalid_intake_answers as POST /v1/requests answers them."
        ),
        status.HTTP_429_TOO_MANY_REQUESTS: _error(
            "rate_limited: too many requests from this visitor's address, or for this email or "
            "phone, in the window or the day; Retry-After says when to try again."
        ),
    },
)
async def create_web_request(
    data: WebRequestIn,
    idempotency_key: Annotated[
        uuid.UUID,
        Header(
            alias="Idempotency-Key",
            description="A UUID the web service makes per visitor submit: the same key with "
            "the same body answers the same code and writes nothing.",
        ),
    ],
    service: Annotated[WebRequestService, Depends(get_web_request_service)],
) -> WebRequestCreated:
    """A request for the BDC from a web visitor who has no account (#86). Called by the web
    app's server with its key (`X-JFI-Web-Key`) and the visitor's address (`X-JFI-Client-IP`):
    the browser never calls it. The request is received, in the BDC's queue, and never sent to
    a pro: the BDC calls the customer, who continues in the app. The contact is for the BDC
    only."""
    return await service.create(data, idempotency_key)
