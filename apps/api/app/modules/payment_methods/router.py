from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.integrations.stripe_payment_methods import (
    StripePaymentMethods,
    get_stripe_payment_methods,
)
from app.integrations.stripe_payments import StripePayments, get_stripe_payments
from app.modules.auth.permissions import CustomerUser
from app.modules.payment_methods.schemas import (
    PAYMENT_METHOD_ID_PATTERN,
    PaymentMethodOut,
    SetupIntentOut,
)
from app.modules.payment_methods.service import PaymentMethodsConfig, PaymentMethodService
from app.rate_limit import RateLimiter, enforce_limit, get_rate_limiter

router = APIRouter(prefix="/me/payment-methods", tags=["payment-methods"])

PaymentMethodId = Annotated[
    str,
    Path(
        pattern=PAYMENT_METHOD_ID_PATTERN,
        description="The saved card's Stripe PaymentMethod id, as the list returns it.",
    ),
]


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_payment_method_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    payments: Annotated[StripePayments | None, Depends(get_stripe_payments)],
    methods: Annotated[StripePaymentMethods | None, Depends(get_stripe_payment_methods)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> PaymentMethodService:
    return PaymentMethodService(
        session, payments, methods, PaymentMethodsConfig.from_settings(settings)
    )


_ACCESS: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
    status.HTTP_403_FORBIDDEN: _error("forbidden: only customers keep payment methods."),
}
_UNAVAILABLE: dict[int | str, dict[str, Any]] = {
    status.HTTP_503_SERVICE_UNAVAILABLE: _error(
        "not_configured: payments are not configured; payments_unavailable: Stripe is not "
        "reachable, asked to retry later or refused the call, the wallet holds more cards than "
        "the API reads, or another change of the same wallet did not end in time; retry later."
    ),
}
_NOT_FOUND: dict[int | str, dict[str, Any]] = {
    status.HTTP_404_NOT_FOUND: _error(
        "payment_method_not_found: no saved card of the caller with this id (an unknown id "
        "and another user's card answer the same)."
    ),
    status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
        "validation_error: the id is not a PaymentMethod id (pm_ and letters, digits or _)."
    ),
}
_RATE_LIMITED: dict[int | str, dict[str, Any]] = {
    status.HTTP_429_TOO_MANY_REQUESTS: {
        **_error("rate_limited: too many payment-method changes; retry later."),
        "headers": {
            "Retry-After": {
                "description": "Seconds until the current limit window ends.",
                "schema": {"type": "integer"},
            }
        },
    },
}


async def limit_payment_method_writes(
    user: CustomerUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """PAYMENT_METHOD_WRITE_LIMIT setup intents, default changes and deletes together, per
    customer, per PAYMENT_METHOD_WRITE_WINDOW_SECONDS: each one is a call to Stripe. The list
    is not limited."""
    await enforce_limit(
        limiter,
        "payment_method_write",
        str(user.id),
        limit=settings.payment_method_write_limit,
        window_seconds=settings.payment_method_write_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


@router.post(
    "/setup-intent",
    status_code=status.HTTP_200_OK,
    response_model=SetupIntentOut,
    summary="Start adding a card to my wallet",
    dependencies=[Depends(limit_payment_method_writes)],
    responses={**_ACCESS, **_RATE_LIMITED, **_UNAVAILABLE},
)
async def create_setup_intent(
    user: CustomerUser,
    payment_methods: Annotated[PaymentMethodService, Depends(get_payment_method_service)],
) -> SetupIntentOut:
    """What the Payment Sheet needs, in setup mode, to save a card: a new SetupIntent's client
    secret, the caller's Stripe Customer (created on the first call, the same one ever after)
    and a new ephemeral key for it, and the publishable key. The card data goes from the app to
    Stripe, never through this API. The body takes no field."""
    return await payment_methods.setup_intent(user)


@router.get(
    "",
    response_model=list[PaymentMethodOut],
    summary="List my saved cards",
    responses={**_ACCESS, **_UNAVAILABLE},
)
async def list_payment_methods(
    user: CustomerUser,
    payment_methods: Annotated[PaymentMethodService, Depends(get_payment_method_service)],
) -> list[PaymentMethodOut]:
    """The caller's saved cards, the most recently added first: the brand, the last four
    digits, the expiry and whether it is the default. Empty until a card is saved. Always the
    whole wallet, in one response: the API reads at most PAYMENT_METHOD_LIST_MAX_PAGES pages
    of 100 cards of one customer from Stripe (500 cards unless the setting is changed), and a
    wallet with more is 503 payments_unavailable, never a partial list."""
    return await payment_methods.list_own(user)


@router.post(
    "/{payment_method_id}/default",
    status_code=status.HTTP_200_OK,
    response_model=PaymentMethodOut,
    summary="Make a saved card my default",
    dependencies=[Depends(limit_payment_method_writes)],
    responses={**_ACCESS, **_NOT_FOUND, **_RATE_LIMITED, **_UNAVAILABLE},
)
async def set_default_payment_method(
    payment_method_id: PaymentMethodId,
    user: CustomerUser,
    payment_methods: Annotated[PaymentMethodService, Depends(get_payment_method_service)],
) -> PaymentMethodOut:
    """Makes the card the caller's default payment method and returns it. Asking again for
    the card that is the default already changes nothing. Default changes and deletes of one
    wallet run one at a time: a call waits for the one before it, and is 503
    payments_unavailable when the wait and its own work together take longer than
    PAYMENT_METHOD_CHANGE_TIMEOUT_SECONDS."""
    return await payment_methods.set_default(user, payment_method_id)


@router.delete(
    "/{payment_method_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a saved card",
    dependencies=[Depends(limit_payment_method_writes)],
    responses={**_ACCESS, **_NOT_FOUND, **_RATE_LIMITED, **_UNAVAILABLE},
)
async def delete_payment_method(
    payment_method_id: PaymentMethodId,
    user: CustomerUser,
    payment_methods: Annotated[PaymentMethodService, Depends(get_payment_method_service)],
) -> Response:
    """Removes the card from the caller's wallet for good. Deleting the default makes the most
    recently added of the other cards the default; with no other card, none is. A card deleted
    already is a 404. Default changes and deletes of one wallet run one at a time, so two
    deletes at once end as one after the other would: a call waits for the one before it, and
    is 503 payments_unavailable when the wait and its own work together take longer than
    PAYMENT_METHOD_CHANGE_TIMEOUT_SECONDS. A wallet with more cards than the list reads cannot
    delete its default card (503): the next default could not be chosen among all of them."""
    await payment_methods.delete(user, payment_method_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
