from app.errors import ConflictError


class EmailAlreadyRegisteredError(ConflictError):
    code = "email_already_registered"
    message = "An account with this email already exists."


class PhoneUnavailableError(ConflictError):
    """The number is already another account's (it became verified there meanwhile)."""

    code = "phone_unavailable"
    message = "This phone number cannot be used for this account."
