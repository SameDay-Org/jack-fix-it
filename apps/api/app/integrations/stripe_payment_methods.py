"""A customer's saved cards on the platform account (#253): the wallet in the profile.

A card is added in the app: the Payment Sheet, in setup mode, confirms a SetupIntent created
here for the customer's Stripe Customer, and the card data goes from the app to Stripe, never
through the API. The SetupIntent takes cards only (`allowed_payment_method_types`; the wallet
keeps cards, #253) and is `on_session`: a saved card is charged
only while the customer confirms a payment in the app, never off-session (ADR 0006). It carries
no idempotency key of ours (the SDK sends a random one per call, for its own retries): each call
is a new attempt to add a card, and a replayed SetupIntent may be one the sheet completed
already.

The other calls read and change what Stripe keeps for the customer: the cards attached to it
(one page of PAYMENT_METHOD_PAGE_SIZE, Stripe's largest), the default one
(`invoice_settings.default_payment_method`), and a detach. They carry no key of ours either: a
replayed answer to "make A the default" would skip a later A after B, and none of them moves
money.

What leaves this module is typed and minimal: a SetupIntent's client secret, and of a card its
PaymentMethod id, the customer it is attached to, the brand, the last four digits, the expiry
and when it was created. Never the fingerprint, the billing details, the checks or the wallet
data. Stripe's errors become `StripeUnavailableError` or `StripeRejectedError`
(stripe_errors.py), each carrying only Stripe's request id and error code; a PaymentMethod
Stripe does not have (404) is None, not an error. The `stripe` logger runs at WARNING
(app/observability.py), and Sentry filters `pm_` and `seti_` ids, as it does `cus_` and `ek_`.
"""

from dataclasses import dataclass, field
from typing import Final, Protocol

import stripe
from starlette.requests import Request
from stripe.params import (
    CustomerUpdateParams,
    PaymentMethodListParams,
    SetupIntentCreateParams,
)

from app.config import Settings
from app.integrations.stripe_errors import StripeRejectedError, raise_typed

# The only type the wallet saves and lists.
CARD: Final = "card"
# Stripe's largest page: a wallet with more cards shows the most recent ones.
PAYMENT_METHOD_PAGE_SIZE: Final = 100


@dataclass(frozen=True)
class CreatedSetupIntent:
    """`client_secret` is what the sheet confirms the setup with: never logged."""

    client_secret: str = field(repr=False)
    request_id: str | None


@dataclass(frozen=True)
class SavedCard:
    """A card PaymentMethod as the wallet shows it. `customer_id` is the Stripe Customer it is
    attached to, None once detached; `created` is Stripe's Unix time."""

    payment_method_id: str
    customer_id: str | None
    brand: str
    last4: str
    exp_month: int
    exp_year: int
    created: int


class StripePaymentMethods(Protocol):
    async def create_setup_intent(self, customer_id: str) -> CreatedSetupIntent:
        """A new SetupIntent that saves a card on the customer (see the module doc)."""
        ...

    async def list_cards(self, customer_id: str) -> tuple[SavedCard, ...]:
        """The cards attached to the customer: one page, at most PAYMENT_METHOD_PAGE_SIZE."""
        ...

    async def retrieve_card(self, payment_method_id: str) -> SavedCard | None:
        """The card with this id, whoever it is attached to; None when Stripe has no such
        PaymentMethod or it is not a card. The caller checks `customer_id`."""
        ...

    async def default_payment_method(self, customer_id: str) -> str | None:
        """The id of the customer's default PaymentMethod; None when it has none."""
        ...

    async def set_default_payment_method(self, customer_id: str, payment_method_id: str) -> None:
        """Makes a PaymentMethod attached to the customer its default."""
        ...

    async def detach(self, payment_method_id: str) -> None:
        """Detaches the PaymentMethod from its customer: it can never be used again."""
        ...


class StripePaymentMethodsClient:
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
    def from_settings(cls, settings: Settings) -> "StripePaymentMethodsClient":
        if settings.stripe_secret_key is None:
            raise RuntimeError("STRIPE_SECRET_KEY is not set; payments are unavailable")
        return cls(
            secret_key=settings.stripe_secret_key.get_secret_value(),
            timeout_seconds=settings.stripe_timeout_seconds,
            max_network_retries=settings.stripe_max_network_retries,
        )

    async def create_setup_intent(self, customer_id: str) -> CreatedSetupIntent:
        params: SetupIntentCreateParams = {
            "customer": customer_id,
            "allowed_payment_method_types": [CARD],
            "usage": "on_session",
        }
        try:
            intent = await self._client.v1.setup_intents.create_async(params=params)
        except stripe.StripeError as error:
            raise_typed(error)
        # A response without the secret cannot be confirmed by any sheet: a refusal, never an
        # empty secret.
        client_secret: str | None = getattr(intent, "client_secret", None)
        if client_secret is None:
            raise StripeRejectedError(request_id=_request_id(intent), code="setup_intent_no_secret")
        return CreatedSetupIntent(client_secret=client_secret, request_id=_request_id(intent))

    async def list_cards(self, customer_id: str) -> tuple[SavedCard, ...]:
        params: PaymentMethodListParams = {
            "customer": customer_id,
            "type": CARD,
            "limit": PAYMENT_METHOD_PAGE_SIZE,
        }
        try:
            page = await self._client.v1.payment_methods.list_async(params=params)
        except stripe.StripeError as error:
            raise_typed(error)
        cards = (_card(method) for method in page.data)
        return tuple(card for card in cards if card is not None)

    async def retrieve_card(self, payment_method_id: str) -> SavedCard | None:
        try:
            method = await self._client.v1.payment_methods.retrieve_async(payment_method_id)
        except stripe.StripeError as error:
            if error.http_status == 404:
                return None
            raise_typed(error)
        return _card(method)

    async def default_payment_method(self, customer_id: str) -> str | None:
        try:
            customer = await self._client.v1.customers.retrieve_async(customer_id)
        except stripe.StripeError as error:
            raise_typed(error)
        # A customer deleted in the Dashboard comes back with `deleted` and no settings.
        settings = getattr(customer, "invoice_settings", None)
        default = getattr(settings, "default_payment_method", None)
        return _object_id(default)

    async def set_default_payment_method(self, customer_id: str, payment_method_id: str) -> None:
        params: CustomerUpdateParams = {
            "invoice_settings": {"default_payment_method": payment_method_id}
        }
        try:
            await self._client.v1.customers.update_async(customer_id, params=params)
        except stripe.StripeError as error:
            raise_typed(error)

    async def detach(self, payment_method_id: str) -> None:
        try:
            await self._client.v1.payment_methods.detach_async(payment_method_id)
        except stripe.StripeError as error:
            raise_typed(error)


def _card(method: stripe.PaymentMethod) -> SavedCard | None:
    """The card fields the wallet shows, and nothing else of the PaymentMethod; None for a
    PaymentMethod that is not a card."""
    card = getattr(method, "card", None)
    if method.type != CARD or card is None:
        return None
    return SavedCard(
        payment_method_id=method.id,
        customer_id=_object_id(getattr(method, "customer", None)),
        brand=card.brand,
        last4=card.last4,
        exp_month=card.exp_month,
        exp_year=card.exp_year,
        created=method.created,
    )


def _object_id(value: object) -> str | None:
    """An expandable field's id: Stripe answers the id, or the object when expanded."""
    if value is None or isinstance(value, str):
        return value
    expanded: str | None = getattr(value, "id", None)
    return expanded


def _request_id(resource: stripe.StripeObject) -> str | None:
    response = resource.last_response
    return response.request_id if response else None


def get_stripe_payment_methods(request: Request) -> StripePaymentMethods | None:
    """FastAPI dependency: one client per app, built on first use (tests override this).

    None without STRIPE_SECRET_KEY (allowed outside staging and production): the wallet
    endpoints then answer 503.
    """
    methods: StripePaymentMethods | None = getattr(
        request.app.state, "stripe_payment_methods", None
    )
    if methods is None:
        settings: Settings = request.app.state.settings
        if settings.stripe_secret_key is None:
            return None
        methods = StripePaymentMethodsClient.from_settings(settings)
        request.app.state.stripe_payment_methods = methods
    return methods
