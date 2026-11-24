from app.errors import AppError, ConflictError


class OutOfAreaError(ConflictError):
    """The ZIP is not served: no request was made, the contact is on its waitlist (#86)."""

    code = "out_of_area"
    message = "We do not serve this ZIP yet. You are on its waitlist."


class WebRequestKeyReusedError(ConflictError):
    """The Idempotency-Key already made a request with another body."""

    code = "idempotency_key_reused"
    message = "This Idempotency-Key was already used with another request."


class LengthRequiredError(AppError):
    """No Content-Length: the body cannot be capped before it is read."""

    status_code = 411
    code = "length_required"
    message = "The request must state its Content-Length."


class WebRequestTooLargeError(AppError):
    status_code = 413
    code = "payload_too_large"
    message = "The request body is too large."
