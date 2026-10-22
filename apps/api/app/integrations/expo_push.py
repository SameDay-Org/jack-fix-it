"""Push notifications through Expo Push (D10.3, #54).

Calls go to the Expo Push API with httpx (async, timeout from settings, a bearer only when
EXPO_ACCESS_TOKEN is set); no Expo SDK. Nothing here logs a push token, a title, a body or a
response body (error bodies can echo them).
"""

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Final, Protocol

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)

SEND_URL: Final = "https://exp.host/--/api/v2/push/send"
RECEIPTS_URL: Final = "https://exp.host/--/api/v2/push/getReceipts"
# Expo's own request limits.
SEND_BATCH: Final = 100
RECEIPTS_BATCH: Final = 1000
DEVICE_NOT_REGISTERED: Final = "DeviceNotRegistered"
# Errors on a ticket or a receipt that a later send to the same device may get past.
RETRYABLE_ERRORS: Final = frozenset({"MessageRateExceeded"})


class PushUnavailableError(Exception):
    """Expo could not be reached, timed out, or answered with an error or an unreadable body.

    `tickets` are Expo's answers for the leading messages, from the batches it took before the
    failure (empty when none): those were sent, so a retry must not send them again.
    """

    def __init__(self, tickets: Sequence["Ticket"] = ()) -> None:
        super().__init__()
        self.tickets = list(tickets)


@dataclass(frozen=True)
class PushMessage:
    to: str
    title: str
    body: str
    data: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Ticket:
    """Expo's answer for one message, in the order sent: an id to check later, or an error."""

    id: str | None
    error: str | None = None


@dataclass(frozen=True)
class Receipt:
    ok: bool
    error: str | None = None


class PushSender(Protocol):
    async def send(self, messages: Sequence[PushMessage]) -> list[Ticket]:
        """One ticket per message, in order. Raises PushUnavailableError, which carries the
        tickets of the messages sent before the failure."""
        ...

    async def get_receipts(self, ticket_ids: Sequence[str]) -> dict[str, Receipt]:
        """The receipts Expo has ready; ids still pending are absent."""
        ...


class ExpoPushSender:
    def __init__(
        self,
        *,
        access_token: str | None,
        timeout_seconds: float,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._headers = {"Accept": "application/json"}
        if access_token is not None:
            self._headers["Authorization"] = f"Bearer {access_token}"
        self._timeout = timeout_seconds
        self._transport = transport

    @classmethod
    def from_settings(cls, settings: Settings) -> "ExpoPushSender":
        token = settings.expo_access_token
        return cls(
            access_token=token.get_secret_value() if token is not None else None,
            timeout_seconds=settings.push_send_timeout_seconds,
        )

    async def send(self, messages: Sequence[PushMessage]) -> list[Ticket]:
        tickets: list[Ticket] = []
        for start in range(0, len(messages), SEND_BATCH):
            batch = messages[start : start + SEND_BATCH]
            payload = [
                {"to": m.to, "title": m.title, "body": m.body, "data": m.data, "sound": "default"}
                for m in batch
            ]
            try:
                data = await self._post(SEND_URL, payload, "send")
            except PushUnavailableError:
                raise PushUnavailableError(tickets) from None  # logged by _post
            if not isinstance(data, list) or len(data) != len(batch):
                logger.error("expo_push_unexpected_response", extra={"operation": "send"})
                raise PushUnavailableError(tickets)
            tickets.extend(_ticket(item) for item in data)
        return tickets

    async def get_receipts(self, ticket_ids: Sequence[str]) -> dict[str, Receipt]:
        receipts: dict[str, Receipt] = {}
        for start in range(0, len(ticket_ids), RECEIPTS_BATCH):
            batch = list(ticket_ids[start : start + RECEIPTS_BATCH])
            data = await self._post(RECEIPTS_URL, {"ids": batch}, "receipts")
            if not isinstance(data, dict):
                logger.error("expo_push_unexpected_response", extra={"operation": "receipts"})
                raise PushUnavailableError
            for ticket_id, item in data.items():
                if isinstance(item, dict):
                    receipts[str(ticket_id)] = _receipt(item)
        return receipts

    async def _post(self, url: str, payload: object, operation: str) -> Any:
        try:
            async with httpx.AsyncClient(
                timeout=self._timeout, transport=self._transport
            ) as client:
                response = await client.post(url, json=payload, headers=self._headers)
        except httpx.HTTPError as error:
            # The exception text may carry the request; log only its type.
            logger.error(
                "expo_push_unreachable",
                extra={"operation": operation, "error": type(error).__name__},
            )
            raise PushUnavailableError from None
        if not response.is_success:
            logger.error(
                "expo_push_failed",
                extra={"operation": operation, "status_code": response.status_code},
            )
            raise PushUnavailableError
        try:
            body = response.json()
        except ValueError:
            body = None
        if not isinstance(body, dict) or "data" not in body:
            logger.error("expo_push_unexpected_response", extra={"operation": operation})
            raise PushUnavailableError
        return body["data"]


def _error_code(item: dict[str, Any]) -> str | None:
    details = item.get("details")
    code = details.get("error") if isinstance(details, dict) else None
    return str(code) if code is not None else "unknown"


def _ticket(item: object) -> Ticket:
    if isinstance(item, dict) and item.get("status") == "ok" and item.get("id"):
        return Ticket(id=str(item["id"]))
    return Ticket(id=None, error=_error_code(item) if isinstance(item, dict) else "unknown")


def _receipt(item: dict[str, Any]) -> Receipt:
    if item.get("status") == "ok":
        return Receipt(ok=True)
    return Receipt(ok=False, error=_error_code(item))
