"""Transactional email through Resend (D4.3, #27).

Calls go to the Resend REST API with httpx (async, bearer auth, timeout from settings); no
Resend SDK. Nothing here logs an address, a subject, a body or a Resend response body (error
bodies can echo the request).
"""

import logging
from typing import Final, Protocol

import httpx
from starlette.requests import Request

from app.config import Settings

logger = logging.getLogger(__name__)

RESEND_EMAILS_URL: Final = "https://api.resend.com/emails"


class EmailUnavailableError(Exception):
    """Resend could not be reached, timed out, or refused the message."""


class EmailSender(Protocol):
    async def send(self, to: str, subject: str, text: str, html: str) -> None:
        """Sends one message. Raises EmailUnavailableError when it was not accepted."""
        ...


class ResendEmailSender:
    def __init__(
        self,
        *,
        api_key: str,
        sender: str,
        timeout_seconds: float,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._sender = sender
        self._timeout = timeout_seconds
        self._transport = transport

    @classmethod
    def from_settings(cls, settings: Settings) -> "ResendEmailSender":
        if settings.resend_api_key is None or settings.email_from is None:
            raise RuntimeError("RESEND_API_KEY and EMAIL_FROM are not set; email is unavailable")
        return cls(
            api_key=settings.resend_api_key.get_secret_value(),
            sender=settings.email_from,
            timeout_seconds=settings.resend_timeout_seconds,
        )

    async def send(self, to: str, subject: str, text: str, html: str) -> None:
        payload = {"from": self._sender, "to": [to], "subject": subject, "text": text, "html": html}
        try:
            async with httpx.AsyncClient(
                timeout=self._timeout, transport=self._transport
            ) as client:
                response = await client.post(RESEND_EMAILS_URL, json=payload, headers=self._headers)
        except httpx.HTTPError as error:
            # The exception text may carry the request; log only its type.
            logger.error("email_unreachable", extra={"error": type(error).__name__})
            raise EmailUnavailableError from None
        if not response.is_success:
            logger.error("email_rejected", extra={"status_code": response.status_code})
            raise EmailUnavailableError


def get_email_sender(request: Request) -> EmailSender:
    """FastAPI dependency: one sender per app, built on first use (tests override this).

    Missing settings raise: a generic, logged 500, never a crash at import or startup.
    """
    sender: EmailSender | None = getattr(request.app.state, "email_sender", None)
    if sender is None:
        sender = ResendEmailSender.from_settings(request.app.state.settings)
        request.app.state.email_sender = sender
    return sender
