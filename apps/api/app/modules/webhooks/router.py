from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, status
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.modules.webhooks.errors import PayloadTooLargeError
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


@router.post(
    "/stripe",
    summary="Receive a Stripe event",
    openapi_extra={
        "requestBody": {
            "required": True,
            "description": "The event exactly as Stripe sent it; the signature covers these bytes.",
            "content": {"application/json": {"schema": {"type": "object"}}},
        }
    },
    responses={
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
    },
)
async def receive_stripe_event(
    request: Request,
    webhooks: Annotated[StripeWebhookService, Depends(get_stripe_webhook_service)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    stripe_signature: Annotated[str | None, Header(alias="Stripe-Signature")] = None,
) -> WebhookReceived:
    """Stripe's only entry point. No access token: the Stripe-Signature HMAC over the raw body
    is the credential. Each event is stored once by its id and handled by the worker; a
    duplicate delivery answers 200 too. Any non-2xx makes Stripe deliver the event again."""
    webhooks.ensure_configured()
    body = await read_body(request, settings.stripe_webhook_max_body_bytes)
    await webhooks.receive(body, stripe_signature)
    return WebhookReceived()
