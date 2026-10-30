"""Stripe webhook signatures (D7.3, #40): the one place the webhook route touches the SDK.

`verify_event` checks the `Stripe-Signature` header against the raw body with the SDK's own
verifier (an HMAC-SHA256 of "<timestamp>.<body>" under the endpoint's secret, compared in
constant time against every `v1` signature, and a timestamp no older than the tolerance), then
reads the few fields the API keeps. What leaves this module is a typed `VerifiedEvent`.

The SDK's error holds the header and the body, so it is never chained, logged or kept:
`InvalidSignatureError` and `InvalidPayloadError` carry nothing.
"""

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final, TypeGuard

import stripe

# The longest event id or type kept (webhook_events stores them as varchar(255)).
MAX_FIELD_LENGTH: Final = 255


class InvalidSignatureError(Exception):
    """No header, a malformed one, no `v1` signature matching the body, a timestamp older than
    the tolerance, or a body that is not UTF-8 (Stripe signs text)."""


class InvalidPayloadError(Exception):
    """The body is signed but is not a Stripe event: not a JSON object, or without a string `id`
    and `type`, an integer `created` and a boolean `livemode`."""


@dataclass(frozen=True)
class VerifiedEvent:
    id: str
    type: str
    livemode: bool
    created: datetime
    # The whole event, as Stripe sent it.
    payload: dict[str, object]


def verify_event(
    payload: bytes, signature: str | None, secret: str, tolerance: int
) -> VerifiedEvent:
    """The event in `payload`, once its signature is proven. Raises InvalidSignatureError or
    InvalidPayloadError; nothing about the body or the header is in either."""
    if tolerance <= 0:
        # The SDK skips the timestamp check on a falsy tolerance: a replay would never expire.
        raise ValueError("tolerance must be positive")
    try:
        stripe.WebhookSignature.verify_header(payload, signature, secret, tolerance)
    except (stripe.SignatureVerificationError, UnicodeDecodeError):
        raise InvalidSignatureError from None
    return _parse(payload)


def _parse(payload: bytes) -> VerifiedEvent:
    try:
        event = json.loads(payload)
    except (ValueError, RecursionError):  # JSONDecodeError is a ValueError
        raise InvalidPayloadError from None
    if not isinstance(event, dict):
        raise InvalidPayloadError
    event_id, event_type = event.get("id"), event.get("type")
    created, livemode = event.get("created"), event.get("livemode")
    if not _is_field(event_id) or not _is_field(event_type):
        raise InvalidPayloadError
    # bool is an int: `"created": true` is not a time.
    if not isinstance(created, int) or isinstance(created, bool):
        raise InvalidPayloadError
    if not isinstance(livemode, bool):
        raise InvalidPayloadError
    try:
        created_at = datetime.fromtimestamp(created, UTC)
    except (OverflowError, OSError, ValueError):
        raise InvalidPayloadError from None
    return VerifiedEvent(
        id=event_id, type=event_type, livemode=livemode, created=created_at, payload=event
    )


def _is_field(value: object) -> TypeGuard[str]:
    return isinstance(value, str) and 0 < len(value) <= MAX_FIELD_LENGTH
