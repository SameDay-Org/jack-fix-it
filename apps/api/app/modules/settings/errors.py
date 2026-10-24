from app.errors import AppError


class SettingNotConfiguredError(AppError):
    """A setting the action needs is missing or invalid, and it has no default (e.g. the quote
    TTL, seeded at 48 hours). Nothing is written; an admin sets the value."""

    status_code = 503
    code = "not_configured"
    message = "This feature is not configured yet."


class SettingMalformedError(SettingNotConfiguredError):
    """An optional setting is present but its value is invalid (e.g. the string "10000" for a
    quote cap). Absent means not set; a malformed value must not read as absent, so the action
    is refused like a missing required setting: 503 not_configured, nothing written. `key` names
    the setting; the value is never kept."""

    def __init__(self, key: str) -> None:
        super().__init__()
        self.key = key
