from app.errors import AppError


class PreferenceLockedError(AppError):
    """A change turns off a locked group (account and security). Nothing in the request is
    stored."""

    status_code = 422
    code = "preference_locked"
    message = "This notification cannot be turned off."
