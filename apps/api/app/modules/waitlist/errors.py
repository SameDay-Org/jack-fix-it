from app.errors import AppError, ConflictError


class ZipServedError(ConflictError):
    """The ZIP is served: the client creates a request instead of joining the waitlist."""

    code = "zip_served"
    message = "This ZIP code is served. Create a request instead."


class InvalidCategoryError(AppError):
    status_code = 422
    code = "invalid_category"
    message = "The category is not available."


class InvalidPhoneNumberError(AppError):
    """A phone outside the allowed country codes (PHONE_ALLOWED_COUNTRY_CODES)."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."
