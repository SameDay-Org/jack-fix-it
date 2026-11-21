from app.errors import AppError


class ReceiptNotAvailableError(AppError):
    """The request's job has no receipt yet: its payment has not gone through."""

    status_code = 404
    code = "receipt_not_available"
    message = "There is no receipt for this request yet."
