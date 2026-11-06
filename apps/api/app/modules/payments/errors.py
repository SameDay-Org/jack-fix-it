from app.errors import AppError


class PaymentNotAvailableError(AppError):
    """The quote cannot be paid now (#58): the request is not accepted or this quote is not
    its accepted one, the payment already succeeded (the job exists or is being created) or
    its PaymentIntent is closed (canceled: the reconciliation in #61 reopens the quote)."""

    status_code = 409
    code = "payment_not_available"
    message = "This quote cannot be paid right now."


class ProNotHireableError(AppError):
    """The accepted quote's pro can no longer be hired (not approved, or payouts disabled):
    rechecked at payment (#189 decision). Nothing is created."""

    status_code = 409
    code = "pro_not_hireable"
    message = "This pro can no longer be hired."


class PaymentsNotConfiguredError(AppError):
    """Stripe is not configured: no secret key (allowed outside staging and production) or no
    publishable key (optional everywhere, so a deploy never fails for it)."""

    status_code = 503
    code = "not_configured"
    message = "Payments are not configured yet."
