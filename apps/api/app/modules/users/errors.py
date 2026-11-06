from app.errors import AppError, ConflictError


class EmailAlreadyRegisteredError(ConflictError):
    code = "email_already_registered"
    message = "An account with this email already exists."


class NamesIncompleteError(AppError):
    """One name would be set while the other stays empty: both are required together."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."


class PhoneUnavailableError(ConflictError):
    """The number is already another account's (it became verified there meanwhile)."""

    code = "phone_unavailable"
    message = "This phone number cannot be used for this account."


class HomeLocationIncompleteError(AppError):
    """The city would be set without the state or the other way round: both go together."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."


class InvalidPhotoError(AppError):
    """The photo key is not the caller's own profile_photo upload; never says which check."""

    status_code = 422
    code = "invalid_media"
    message = "The attached media is invalid."


class PublicCodeExhaustedError(RuntimeError):
    """Every try at a public code collided (users.public_codes.MAX_TRIES): a generic 500,
    logged without any code."""

    def __init__(self) -> None:
        super().__init__("no free public code found")
