"""Stripe in TEST mode, for the jobs the video itself pays, refunds or shows a card for.

The disputed job the admin resolves on camera must be refundable, so its PaymentIntent is a
real TEST one, charged with Stripe's test card `pm_card_visa` the way the Payment Sheet
confirms it in the app. The key is checked to be a TEST key before any call (guard.py checks
the settings too); a live key is refused. Nothing here logs or prints a key, a client secret or
a Stripe response.
"""

from typing import Final

import stripe

from app.config import Settings
from app.integrations.stripe_payments import PaymentIntentFacts, StripePaymentsClient
from app.integrations.stripe_refunds import StripeRefundsClient
from app.integrations.stripe_transfers import StripeTransfersClient
from demo_seed.guard import STRIPE_TEST_PREFIX
from demo_seed.world import Gateways, SeedError

# Stripe's test PaymentMethod for a Visa that always succeeds.
TEST_CARD: Final = "pm_card_visa"
_SUCCEEDED: Final = "succeeded"


def has_test_key(settings: Settings) -> bool:
    key = settings.stripe_secret_key
    return key is not None and key.get_secret_value().startswith(STRIPE_TEST_PREFIX)


def test_gateways(settings: Settings) -> Gateways:
    """The API's own Stripe clients, on the TEST key."""
    _require_test_key(settings)
    return Gateways(
        payments=StripePaymentsClient.from_settings(settings),
        transfers=StripeTransfersClient.from_settings(settings),
        refunds=StripeRefundsClient.from_settings(settings),
    )


class CardCheckout:
    """flows.Checkout on Stripe TEST: confirms the PaymentIntent with the test card."""

    def __init__(self, settings: Settings) -> None:
        self._client = stripe.StripeClient(
            _require_test_key(settings),
            http_client=stripe.HTTPXClient(timeout=settings.stripe_timeout_seconds),
            max_network_retries=settings.stripe_max_network_retries,
        )
        self._payments = StripePaymentsClient.from_settings(settings)

    async def charge(self, payment_intent_id: str) -> PaymentIntentFacts:
        try:
            intent = await self._client.v1.payment_intents.confirm_async(
                payment_intent_id, params={"payment_method": TEST_CARD}
            )
        except stripe.StripeError as error:
            raise SeedError(f"Stripe TEST refused the charge ({error.code})") from None
        if intent.status != _SUCCEEDED:
            raise SeedError(f"Stripe TEST left the payment {intent.status}")
        return await self._payments.payment_intent_facts(payment_intent_id)

    async def save_card(self, setup_intent_client_secret: str) -> None:
        """Confirms the wallet's SetupIntent with the test card, as the app's card form does:
        the customer's Stripe Customer then holds a saved Visa."""
        setup_intent_id = setup_intent_client_secret.split("_secret_")[0]
        try:
            await self._client.v1.setup_intents.confirm_async(
                setup_intent_id, params={"payment_method": TEST_CARD}
            )
        except stripe.StripeError as error:
            raise SeedError(f"Stripe TEST refused the saved card ({error.code})") from None


def _require_test_key(settings: Settings) -> str:
    key = settings.stripe_secret_key
    if key is None or not key.get_secret_value().startswith(STRIPE_TEST_PREFIX):
        raise SeedError("STRIPE_SECRET_KEY is not a TEST key (sk_test_...)")
    return key.get_secret_value()
