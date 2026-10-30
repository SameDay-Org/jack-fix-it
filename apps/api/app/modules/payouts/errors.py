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
    """An account create is unresolved: the lookup after it found no account, more than one,
    or could not tell. Support resolves it (scripts/resolve_payout_account.py) before another
    account is created."""

    status_code = 409
    code = "payouts_needs_review"
    message = "Your payout account needs a review by our support team."


class PayoutsRecoveryRefusedError(Exception):
    """A staff recovery of a payout account was refused. The message is for the operator and
    never holds an account id or an email."""
