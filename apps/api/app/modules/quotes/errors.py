from app.errors import AppError


class NotQuotableError(AppError):
    """The caller's own dispatch can no longer be quoted: declined, expired, or its request
    closed (no longer finding a pro or with quotes ready)."""

    status_code = 409
    code = "not_quotable"
    message = "This opportunity can no longer be quoted."


class QuoteExistsError(AppError):
    """The pro already quoted this request; a quote is sent once (withdrawing is out of #50)."""

    status_code = 409
    code = "quote_exists"
    message = "You already sent a quote for this request."


class QuoteOutOfBoundsError(AppError):
    """The amount or the duration is above the platform's cap (settings). The same body as any
    other validation error."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."
