from types import MappingProxyType

from app.errors import AppError, BadRequestError, ForbiddenError, UnauthorizedError


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


class InvalidRefreshTokenError(UnauthorizedError):
    """Same body for an unknown, expired, revoked, reused or malformed refresh token.

    No WWW-Authenticate: the refresh token is sent in the body, not as a bearer credential.
    """

    code = "invalid_refresh_token"
    message = "The refresh token is invalid or expired."


class PasswordTooShortError(AppError):
    """PASSWORD_MIN_LENGTH is a setting, so it is checked after schema validation."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."


class InvalidPhoneNumberError(AppError):
    """A phone outside the allowed country codes, or one Twilio cannot send to."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."


class InvalidCodeError(BadRequestError):
    """Same body for a wrong, expired or already used code."""

    code = "invalid_code"
    message = "The code is incorrect or has expired."


class VerificationUnavailableError(AppError):
    status_code = 503
    code = "verification_unavailable"
    message = "Phone verification is unavailable right now. Try again later."
