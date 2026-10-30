from app.errors import AppError


class PaymentsUnavailableError(AppError):
    """Stripe is not configured, not reachable, timed out, or asked to retry later."""

    status_code = 503
    code = "payments_unavailable"
    message = "Payments are unavailable right now. Try again later."


class PaymentsProviderError(AppError):
    """Stripe refused the call (a 4xx), such as for an account deleted on its side."""

    status_code = 502
    code = "payments_error"
    message = "The payment provider could not complete the request."


class PayoutsNeedsReviewError(AppError):
    """Stripe holds more than one account for the pro, or the lookup could not tell: support
    resolves it in the Stripe dashboard before another account is created."""

    status_code = 409
    code = "payouts_needs_review"
    message = "Your payout account needs a review by our support team."
