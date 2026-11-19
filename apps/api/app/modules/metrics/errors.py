from app.errors import AppError


class InvalidRangeError(AppError):
    """A range the metrics do not read: `from` after `to`, longer than METRICS_MAX_RANGE_DAYS,
    or a time zone that is not an IANA name."""

    status_code = 422
    code = "invalid_range"
    message = "The date range or time zone is invalid."
