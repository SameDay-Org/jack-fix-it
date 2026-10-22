from app.errors import AppError


class SettingNotConfiguredError(AppError):
    """A setting the action needs is missing or invalid, and it has no default (e.g. the quote
    TTL, seeded at 48 hours). Nothing is written; an admin sets the value."""

    status_code = 503
    code = "not_configured"
    message = "This feature is not configured yet."
