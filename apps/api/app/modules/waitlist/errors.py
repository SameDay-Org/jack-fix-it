from app.errors import AppError, ConflictError


class ZipServedError(ConflictError):
    """The ZIP is served: the client creates a request instead of joining the waitlist."""

    code = "zip_served"
    message = "This ZIP code is served. Create a request instead."


class InvalidCategoryError(AppError):
    status_code = 422
    code = "invalid_category"
    message = "The category is not available."


class WaitlistWriteError(Exception):
    """A waitlist write broke a constraint the join does not expect: a server error (500).

    Carries the constraint's name only. The driver's message holds the row's values (an email,
    a phone), so it is raised `from None` and never reaches the logs or Sentry."""

    def __init__(self, constraint: str | None) -> None:
        super().__init__(f"waitlist write broke constraint {constraint}")
        self.constraint = constraint


class InvalidPhoneNumberError(AppError):
    """A phone outside the allowed country codes (PHONE_ALLOWED_COUNTRY_CODES)."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."
