from types import MappingProxyType

from app.errors import AppError, ForbiddenError, UnauthorizedError


class InvalidCredentialsError(UnauthorizedError):
    """Same body for an unknown email and a wrong password."""

    code = "invalid_credentials"
    message = "The email or password is incorrect."


class AccountSuspendedError(ForbiddenError):
    code = "account_suspended"
    message = "This account is suspended."


class InvalidTokenError(UnauthorizedError):
    code = "invalid_token"
    message = "The access token is missing, invalid or expired."
    headers = MappingProxyType({"WWW-Authenticate": "Bearer"})


class PasswordTooShortError(AppError):
    """PASSWORD_MIN_LENGTH is a setting, so it is checked after schema validation."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."
