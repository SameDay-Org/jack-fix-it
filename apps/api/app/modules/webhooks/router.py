from typing import Annotated, Any, Final

from fastapi import APIRouter, Depends, FastAPI, Header, status
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse, PayloadTooLargeError
from app.modules.webhooks.schemas import WebhookReceived
from app.modules.webhooks.service import StripeWebhookService, WebhookConfig
from app.queue import JobQueue, get_job_queue

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_stripe_webhook_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    queue: Annotated[JobQueue, Depends(get_job_queue)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> StripeWebhookService:
    return StripeWebhookService(session, queue, WebhookConfig.from_settings(settings))


def get_stripe_connect_webhook_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    queue: Annotated[JobQueue, Depends(get_job_queue)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> StripeWebhookService:
    return StripeWebhookService(session, queue, WebhookConfig.connect_from_settings(settings))


async def read_body(request: Request, limit: int) -> bytes:
    """The raw body, refused past `limit` bytes. Content-Length is checked first but not
    trusted: the stream is counted as it is read."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise PayloadTooLargeError
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > limit:
            raise PayloadTooLargeError
    return bytes(body)


_EVENT_BODY: Final[dict[str, Any]] = {
    "requestBody": {
        "required": True,
        "description": "The event exactly as Stripe sent it; the signature covers these bytes.",
        "content": {"application/json": {"schema": {"type": "object"}}},
    }
}
_EVENT_RESPONSES: Final[dict[int | str, dict[str, Any]]] = {
    status.HTTP_400_BAD_REQUEST: _error(
        "invalid_signature: Stripe-Signature is missing, does not match the body or is too "
        "old; invalid_payload: the signed body is not a Stripe event."
    ),
    status.HTTP_413_CONTENT_TOO_LARGE: _error("payload_too_large: the body is too large."),
    status.HTTP_500_INTERNAL_SERVER_ERROR: _error(
        "internal_error: the event could not be stored or queued; Stripe delivers it again."
    ),
    status.HTTP_503_SERVICE_UNAVAILABLE: _error(
        "not_configured: the signing secret is not set; Stripe delivers it again."
    ),
}


@router.post(
    "/stripe",
    summary="Receive a Stripe event",
    openapi_extra=_EVENT_BODY,
    responses=_EVENT_RESPONSES,
)
async def receive_stripe_event(
    request: Request,
    webhooks: Annotated[StripeWebhookService, Depends(get_stripe_webhook_service)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    stripe_signature: Annotated[str | None, Header(alias="Stripe-Signature")] = None,
) -> WebhookReceived:
    """The platform's events. No access token: the Stripe-Signature HMAC over the raw body
    (STRIPE_WEBHOOK_SECRET) is the credential. Each event is stored once by its id and handled
    by the worker; a duplicate delivery answers 200 too. Any non-2xx makes Stripe deliver the
    event again."""
    webhooks.ensure_configured()
    body = await read_body(request, settings.stripe_webhook_max_body_bytes)
    await webhooks.receive(body, stripe_signature)
    return WebhookReceived()


@router.post(
    "/stripe/connect",
    summary="Receive a Stripe Connect event",
    openapi_extra=_EVENT_BODY,
    responses=_EVENT_RESPONSES,
)
async def receive_stripe_connect_event(
    request: Request,
    webhooks: Annotated[StripeWebhookService, Depends(get_stripe_connect_webhook_service)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    stripe_signature: Annotated[str | None, Header(alias="Stripe-Signature")] = None,
) -> WebhookReceived:
    """The events of the pros' connected accounts (#280), from Stripe's Connect endpoint, which
    signs with its own secret (STRIPE_CONNECT_WEBHOOK_SECRET): a platform-signed body is
    refused here, and a Connect-signed one on the platform route. Only account.updated is
    handled; any other type is stored as ignored. Otherwise as the platform route."""
    webhooks.ensure_configured()
    body = await read_body(request, settings.stripe_webhook_max_body_bytes)
    await webhooks.receive(body, stripe_signature)
    return WebhookReceived()


RAW_BODY_ENDPOINTS: Final = frozenset({receive_stripe_event, receive_stripe_connect_event})


def raw_body_limits(app: FastAPI, settings: Settings) -> dict[str, int]:
    """The paths of the routes that read their raw body, each with its own cap: the app-wide
    HTTP_MAX_BODY_BYTES (#523) gives way to it there. A route that is not mounted fails here,
    at startup."""
    return {
        app.url_path_for(endpoint.__name__): settings.stripe_webhook_max_body_bytes
        for endpoint in RAW_BODY_ENDPOINTS
    }
