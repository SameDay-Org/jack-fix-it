"""The saved cards' part of an account deletion (#97): every card on the account's Stripe
Customer is detached, so none can ever be charged again. The Customer itself stays: payments
name it, and it holds no name or email (payments.service creates it with the user id only)."""

from app.integrations.stripe_payment_methods import StripePaymentMethods


async def detach_all_cards(methods: StripePaymentMethods, customer_id: str) -> int:
    """Detaches every card listed under the Customer; how many. Idempotent: a detached card
    is no longer listed, so a run after a partial one detaches the rest. Raises Stripe's typed
    errors (StripeUnavailableError, StripeRejectedError); the caller tries again later."""
    cards = await methods.list_cards(customer_id)
    for card in cards:
        await methods.detach(card.payment_method_id)
    return len(cards)
