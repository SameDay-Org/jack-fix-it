from app.errors import AppError


class InvalidProfileError(AppError):
    """A list with duplicates or more entries than the settings allow."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."


class InvalidMediaError(AppError):
    """The photo key is not the caller's own profile_photo upload; never says which check."""

    status_code = 422
    code = "invalid_media"
    message = "The attached media is invalid."


class InvalidCategoryError(AppError):
    status_code = 422
    code = "invalid_category"
    message = "The category is not available."


class InvalidServiceAreaError(AppError):
    status_code = 422
    code = "invalid_service_area"
    message = "The service area is not available."


class InvalidDocumentError(AppError):
    """A value the schema cannot check alone, such as an expiry date in the past."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."
