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
