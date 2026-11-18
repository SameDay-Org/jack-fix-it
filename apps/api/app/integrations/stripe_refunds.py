"""Stripe refunds of a customer's payment (#76: an admin's dispute resolution).

A refund goes back to the original payment method: it names the PaymentIntent, and Stripe
refunds its charge. Every create carries the caller's idempotency key and metadata naming what
it is for (`dispute_id`).

A refund whose create answer was lost is found again by listing the PaymentIntent's refunds
(one page of REFUND_LIST_LIMIT; the List API reads Stripe's own records, so it is not eventually
consistent like Search) and reading each refund's metadata.

What leaves this module is typed and minimal: a refund's id, amount, currency, metadata
dispute_id and whether it still stands (`live`: not failed or canceled). Stripe's errors become
`StripeUnavailableError` or `StripeRejectedError` (stripe_errors.py), carrying only Stripe's
request id and error code: an SDK error's text can name the payment or the customer, so it is
never chained or logged. Calls go through the official SDK's async client on httpx (timeout and
retries from settings).
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final, Protocol

import stripe
from fastapi import Request
from stripe.params import RefundCreateParams, RefundListParams

from app.config import Settings
from app.integrations.stripe_errors import raise_typed

# One page of a PaymentIntent's refunds: a job has one payment and a dispute one refund, so more
# than a page is already an answer (the caller cannot tell, and creates nothing).
REFUND_LIST_LIMIT: Final = 100
# Stripe's statuses of a refund that did not, and will not, give the money back.
_DEAD_STATUSES: Final = frozenset({"failed", "canceled"})


@dataclass(frozen=True)
class RefundFacts:
    """A refund as the caller compares it with its row. `dispute_id` (metadata) is None when
    the refund has none; `live`: Stripe has not failed or canceled it."""

    refund_id: str
    amount_cents: int
    currency: str
    dispute_id: str | None
    live: bool
    request_id: str | None


@dataclass(frozen=True)
class FoundRefunds:
    """The refunds of a PaymentIntent. `complete`: the listing returned every one."""

    refunds: tuple[RefundFacts, ...]
    complete: bool


class StripeRefunds(Protocol):
    async def create_refund(
        self,
        *,
        payment_intent_id: str,
        amount_cents: int,
        metadata: Mapping[str, str],
        idempotency_key: str,
    ) -> RefundFacts:
        """Refunds `amount_cents` of the PaymentIntent's charge to its payment method."""
        ...

    async def list_refunds(self, payment_intent_id: str) -> FoundRefunds:
        """The PaymentIntent's refunds, one page."""
        ...


class StripeRefundsClient:
    def __init__(
        self,
        *,
        secret_key: str,
        timeout_seconds: float,
        max_network_retries: int,
        http_client: stripe.HTTPClient | None = None,
    ) -> None:
        self._client = stripe.StripeClient(
            secret_key,
            # The async-only httpx client: a synchronous call raises instead of blocking.
            http_client=http_client or stripe.HTTPXClient(timeout=timeout_seconds),
            max_network_retries=max_network_retries,
        )

    @classmethod
    def from_settings(cls, settings: Settings) -> "StripeRefundsClient":
        if settings.stripe_secret_key is None:
            raise RuntimeError("STRIPE_SECRET_KEY is not set; refunds are unavailable")
        return cls(
            secret_key=settings.stripe_secret_key.get_secret_value(),
            timeout_seconds=settings.stripe_timeout_seconds,
            max_network_retries=settings.stripe_max_network_retries,
        )

    async def create_refund(
        self,
        *,
        payment_intent_id: str,
        amount_cents: int,
        metadata: Mapping[str, str],
        idempotency_key: str,
    ) -> RefundFacts:
        params: RefundCreateParams = {
            "payment_intent": payment_intent_id,
            "amount": amount_cents,
            "metadata": dict(metadata),
        }
        try:
            refund = await self._client.v1.refunds.create_async(
                params=params, options={"idempotency_key": idempotency_key}
            )
        except stripe.StripeError as error:
            raise_typed(error)
        return _facts(refund)

    async def list_refunds(self, payment_intent_id: str) -> FoundRefunds:
        params: RefundListParams = {"payment_intent": payment_intent_id, "limit": REFUND_LIST_LIMIT}
        try:
            page = await self._client.v1.refunds.list_async(params=params)
        except stripe.StripeError as error:
            raise_typed(error)
        return FoundRefunds(
            refunds=tuple(_facts(refund) for refund in page.data), complete=not page.has_more
        )


def _facts(refund: stripe.Refund) -> RefundFacts:
    metadata = refund.metadata
    response = refund.last_response
    return RefundFacts(
        refund_id=refund.id,
        amount_cents=refund.amount,
        currency=refund.currency,
        dispute_id=(
            metadata["dispute_id"] if metadata is not None and "dispute_id" in metadata else None
        ),
        live=refund.status not in _DEAD_STATUSES,
        request_id=response.request_id if response else None,
    )


def get_stripe_refunds(request: Request) -> StripeRefunds | None:
    """FastAPI dependency: one client per app, built on first use (tests override this). None
    without STRIPE_SECRET_KEY (allowed outside staging and production): a resolution that
    refunds then answers 503."""
    refunds: StripeRefunds | None = getattr(request.app.state, "stripe_refunds", None)
    if refunds is None:
        settings: Settings = request.app.state.settings
        if settings.stripe_secret_key is None:
            return None
        refunds = StripeRefundsClient.from_settings(settings)
        request.app.state.stripe_refunds = refunds
    return refunds
