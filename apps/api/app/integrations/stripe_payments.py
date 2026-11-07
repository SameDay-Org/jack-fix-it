"""Stripe payments on the platform account (D11.1, #58; ADR 0005, ADR 0006).

The customer pays through a PaymentIntent the app's Payment Sheet (#59) confirms. It is created on
the platform account, with no `transfer_data` or `on_behalf_of` (separate charges and transfers:
the money stays on the platform balance, and the transfer to the pro follows the confirmation),
captured automatically (no pre-authorization), with `automatic_payment_methods` enabled and
redirects off, so the sheet offers card, Apple Pay and Google Pay. Each customer gets one Stripe
Customer, which the sheet reaches through an ephemeral key created with the SDK's pinned API
version. Calls go through the official SDK's async client on httpx (timeout and retries from
settings): no synchronous call blocks the event loop.

A PaymentIntent left unpaid past PAYMENT_UNPAID_CANCEL_AFTER_SECONDS is canceled (#297,
`cancellation_reason` abandoned). Stripe refuses to cancel an intent that is processing,
succeeded or canceled already (`payment_intent_unexpected_state`): that answer is False, not an
error, since it only means the intent is not ours to cancel now.

A payment whose create answer was lost for longer than Stripe keeps idempotency keys finds
its PaymentIntent again with Stripe Search on the metadata payment_id (one page of at most
PAYMENT_INTENT_SEARCH_LIMIT); Search is eventually consistent, so an empty answer proves nothing.

What leaves this module is typed and minimal: a customer's id, a PaymentIntent's id, client
secret and status, an ephemeral key's secret, and what recovery compares with the payment row
(amount, currency, customer, metadata payment_id). Stripe's errors become `StripeUnavailableError`
(network, timeout, 409, 429, 5xx) or `StripeRejectedError` (any other 4xx), each carrying only
Stripe's request id and error code (stripe_errors.py): an SDK error's text can name the customer
or the PaymentIntent, so it is never chained or logged. The `stripe` logger runs at WARNING
(app/observability.py), and Sentry filters `cus_`, `pi_` and `ek_` ids from URLs and messages.
"""

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

import stripe
from starlette.requests import Request
from stripe.params import (
    CustomerCreateParams,
    EphemeralKeyCreateParams,
    PaymentIntentCancelParams,
    PaymentIntentCreateParams,
    PaymentIntentSearchParams,
)

from app.config import Settings
from app.integrations.stripe_errors import StripeRejectedError, raise_typed

# Stripe's statuses of a PaymentIntent that no sheet can confirm again (the payment's own status
# follows them through the webhooks, #61).
PAYMENT_INTENT_CLOSED_STATUSES: frozenset[str] = frozenset({"succeeded", "canceled"})
# Stripe's error code for a cancel of an intent that is processing, succeeded or canceled.
PAYMENT_INTENT_UNEXPECTED_STATE = "payment_intent_unexpected_state"
# One search page: more than one match is already an answer (ambiguous), so a single page
# of this size counts them for the log.
PAYMENT_INTENT_SEARCH_LIMIT = 10


@dataclass(frozen=True)
class CreatedCustomer:
    customer_id: str
    request_id: str | None


@dataclass(frozen=True)
class PaymentIntentState:
    """A PaymentIntent as the sheet needs it. `status` is Stripe's (requires_payment_method,
    processing, succeeded, canceled...), passed through."""

    payment_intent_id: str
    client_secret: str
    status: str
    request_id: str | None


@dataclass(frozen=True)
class PaymentIntentFacts:
    """What recovery compares with the payment row before adopting a PaymentIntent (#58 B1).
    `customer_id` and `payment_id` (metadata) are None when the intent has none."""

    payment_intent_id: str
    amount_cents: int
    currency: str
    customer_id: str | None
    payment_id: str | None


@dataclass(frozen=True)
class FoundPaymentIntents:
    """The PaymentIntents whose metadata names a payment. `complete`: the search returned every
    match (no further page)."""

    intents: tuple[PaymentIntentFacts, ...]
    complete: bool


class StripePayments(Protocol):
    async def create_customer(self, *, user_id: str, idempotency_key: str) -> CreatedCustomer:
        """Creates a Customer whose metadata names the user; no email or name."""
        ...

    async def create_payment_intent(
        self,
        *,
        amount_cents: int,
        currency: str,
        customer_id: str,
        transfer_group: str,
        metadata: Mapping[str, str],
        idempotency_key: str,
    ) -> PaymentIntentState:
        """Creates the PaymentIntent on the platform account (see the module doc)."""
        ...

    async def retrieve_payment_intent(self, payment_intent_id: str) -> PaymentIntentState: ...

    async def search_payment_intents(self, payment_id: uuid.UUID) -> FoundPaymentIntents:
        """The platform's PaymentIntents whose metadata payment_id is `payment_id` (Stripe
        Search: eventually consistent, so a recent intent may be missing)."""
        ...

    async def payment_intent_facts(self, payment_intent_id: str) -> PaymentIntentFacts:
        """The intent's amount, currency, customer and metadata payment_id (staff recovery)."""
        ...

    async def create_ephemeral_key(self, customer_id: str) -> str:
        """A new ephemeral key's secret for the customer, for the Payment Sheet."""
        ...

    async def cancel_payment_intent(self, payment_intent_id: str, *, idempotency_key: str) -> bool:
        """Cancels an unpaid PaymentIntent (abandoned); False when Stripe refuses because it is
        processing, succeeded or canceled already (see the module doc)."""
        ...


class StripePaymentsClient:
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
    def from_settings(cls, settings: Settings) -> "StripePaymentsClient":
        if settings.stripe_secret_key is None:
            raise RuntimeError("STRIPE_SECRET_KEY is not set; payments are unavailable")
        return cls(
            secret_key=settings.stripe_secret_key.get_secret_value(),
            timeout_seconds=settings.stripe_timeout_seconds,
            max_network_retries=settings.stripe_max_network_retries,
        )

    async def create_customer(self, *, user_id: str, idempotency_key: str) -> CreatedCustomer:
        params: CustomerCreateParams = {"metadata": {"user_id": user_id}}
        try:
            customer = await self._client.v1.customers.create_async(
                params=params, options={"idempotency_key": idempotency_key}
            )
        except stripe.StripeError as error:
            raise_typed(error)
        return CreatedCustomer(customer_id=customer.id, request_id=_request_id(customer))

    async def create_payment_intent(
        self,
        *,
        amount_cents: int,
        currency: str,
        customer_id: str,
        transfer_group: str,
        metadata: Mapping[str, str],
        idempotency_key: str,
    ) -> PaymentIntentState:
        params: PaymentIntentCreateParams = {
            "amount": amount_cents,
            "currency": currency,
            "customer": customer_id,
            # The Dashboard's payment method configuration, minus redirect-based methods: the
            # sheet confirms in the app, with no return URL (card, Apple Pay and Google Pay
            # need none). No capture_method: automatic capture (ADR 0006). No transfer_data or
            # on_behalf_of: the charge is the platform's (ADR 0005).
            "automatic_payment_methods": {"enabled": True, "allow_redirects": "never"},
            "transfer_group": transfer_group,
            "metadata": dict(metadata),
        }
        try:
            intent = await self._client.v1.payment_intents.create_async(
                params=params, options={"idempotency_key": idempotency_key}
            )
        except stripe.StripeError as error:
            raise_typed(error)
        return _state(intent)

    async def retrieve_payment_intent(self, payment_intent_id: str) -> PaymentIntentState:
        try:
            intent = await self._client.v1.payment_intents.retrieve_async(payment_intent_id)
        except stripe.StripeError as error:
            raise_typed(error)
        return _state(intent)

    async def search_payment_intents(self, payment_id: uuid.UUID) -> FoundPaymentIntents:
        # A UUID: nothing in it needs quoting in the query.
        params: PaymentIntentSearchParams = {
            "query": f"metadata['payment_id']:'{payment_id}'",
            "limit": PAYMENT_INTENT_SEARCH_LIMIT,
        }
        try:
            page = await self._client.v1.payment_intents.search_async(params=params)
        except stripe.StripeError as error:
            raise_typed(error)
        return FoundPaymentIntents(
            intents=tuple(_facts(intent) for intent in page.data),
            complete=not page.has_more,
        )

    async def payment_intent_facts(self, payment_intent_id: str) -> PaymentIntentFacts:
        try:
            intent = await self._client.v1.payment_intents.retrieve_async(payment_intent_id)
        except stripe.StripeError as error:
            raise_typed(error)
        return _facts(intent)

    async def create_ephemeral_key(self, customer_id: str) -> str:
        params: EphemeralKeyCreateParams = {"customer": customer_id}
        try:
            key = await self._client.v1.ephemeral_keys.create_async(
                # The key is minted for the SDK's pinned API version; the sheet sends it back
                # with every call it makes for the customer.
                params=params,
                options={"stripe_version": stripe.api_version},
            )
        except stripe.StripeError as error:
            raise_typed(error)
        # Typed as present on the SDK object, but read defensively: a body without it would
        # raise instead of answering.
        secret: str | None = getattr(key, "secret", None)
        if secret is None:
            raise StripeRejectedError(request_id=_request_id(key), code="ephemeral_key_no_secret")
        return secret

    async def cancel_payment_intent(self, payment_intent_id: str, *, idempotency_key: str) -> bool:
        params: PaymentIntentCancelParams = {"cancellation_reason": "abandoned"}
        try:
            await self._client.v1.payment_intents.cancel_async(
                payment_intent_id, params=params, options={"idempotency_key": idempotency_key}
            )
        except stripe.StripeError as error:
            code = error.code or (error.error.code if error.error else None)
            if error.http_status == 400 and code == PAYMENT_INTENT_UNEXPECTED_STATE:
                return False
            raise_typed(error)
        return True


def _state(intent: stripe.PaymentIntent) -> PaymentIntentState:
    # The platform's own key always reads the client secret; a response without one cannot
    # be confirmed by any sheet, so it is a refusal, never an empty secret.
    client_secret: str | None = getattr(intent, "client_secret", None)
    if client_secret is None:
        raise StripeRejectedError(request_id=_request_id(intent), code="payment_intent_no_secret")
    return PaymentIntentState(
        payment_intent_id=intent.id,
        client_secret=client_secret,
        status=intent.status,
        request_id=_request_id(intent),
    )


def _facts(intent: stripe.PaymentIntent) -> PaymentIntentFacts:
    customer = intent.customer
    customer_id = customer if isinstance(customer, str) or customer is None else customer.id
    metadata = intent.metadata
    named = metadata["payment_id"] if metadata is not None and "payment_id" in metadata else None
    return PaymentIntentFacts(
        payment_intent_id=intent.id,
        amount_cents=intent.amount,
        currency=intent.currency,
        customer_id=customer_id,
        payment_id=named,
    )


def _request_id(resource: stripe.StripeObject) -> str | None:
    response = resource.last_response
    return response.request_id if response else None


def get_stripe_payments(request: Request) -> StripePayments | None:
    """FastAPI dependency: one client per app, built on first use (tests override this).

    None without STRIPE_SECRET_KEY (allowed outside staging and production): the payment
    endpoint then answers 503.
    """
    payments: StripePayments | None = getattr(request.app.state, "stripe_payments", None)
    if payments is None:
        settings: Settings = request.app.state.settings
        if settings.stripe_secret_key is None:
            return None
        payments = StripePaymentsClient.from_settings(settings)
        request.app.state.stripe_payments = payments
    return payments
