from app.errors import AppError


class InvalidRequestError(AppError):
    """A value the schema cannot check alone: a past date, oversized intake answers, a bad
    cursor. The same body as any other validation error."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."


class InvalidCategoryError(AppError):
    status_code = 422
    code = "invalid_category"
    message = "The category is not available."


class InvalidMediaError(AppError):
    """One body for every media problem, so it never says which key, or whose, failed."""

    status_code = 422
    code = "invalid_media"
    message = "The attached media is invalid."
