"""How a Stripe call's failure leaves an integration wrapper (#39, #58).

Shared by the Connect wrapper (stripe_connect.py) and the payments wrapper (stripe_payments.py),
so both classify Stripe's errors the same way: `StripeUnavailableError` for what a retry may fix
(network, timeout, 409, 429, 5xx) and `StripeRejectedError` for any other 4xx. Each carries only
Stripe's request id and error code: an SDK error's text can name an account, a customer or a
PaymentIntent, so it is never chained or logged.
"""

from typing import NoReturn

import stripe


class StripeCallError(Exception):
    """A Stripe call failed. Carries Stripe's request id and error code, never its message."""

    def __init__(self, *, request_id: str | None = None, code: str | None = None) -> None:
        super().__init__(type(self).__name__)
        self.request_id = request_id
        self.code = code


class StripeUnavailableError(StripeCallError):
    """Stripe could not be reached, timed out, rate-limited the call or answered a 5xx."""


class StripeRejectedError(StripeCallError):
    """Stripe answered a 4xx: a bad request, a deleted object, a key it refuses."""


def raise_typed(error: stripe.StripeError) -> NoReturn:
    """Stripe's error as ours, with its request id and code only; never chained, as its text
    and body can name the account, the customer or the PaymentIntent."""
    status = error.http_status
    # No status: the network or a timeout. 409 (a concurrent request, a lock timeout) and 429
    # are Stripe's own "retry later".
    kind = (
        StripeUnavailableError
        if status is None or status in (409, 429) or status >= 500
        else StripeRejectedError
    )
    # The SDK sets `code` on some error classes only; the parsed error body has it on all.
    code = error.code or (error.error.code if error.error else None)
    raise kind(request_id=error.request_id, code=code) from None
