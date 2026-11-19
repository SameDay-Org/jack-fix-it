from app.errors import AppError


class TipNotAvailableError(AppError):
    """The job takes no tip now: it was never confirmed (still under way, disputed, refunded or
    cancelled, or paid out by an admin's decision), or its tip window closed."""

    status_code = 409
    code = "tip_not_available"
    message = "This job cannot take a tip right now."


class TipAlreadyPaidError(AppError):
    """The tip succeeded: it is never changed or charged again."""

    status_code = 409
    code = "tip_already_paid"
    message = "The tip for this job is already paid."


class TipInProgressError(AppError):
    """The tip's payment is being processed, or another change of the tip is under way: the
    customer waits and tries again."""

    status_code = 409
    code = "tip_in_progress"
    message = "The tip for this job is being processed. Try again shortly."


class TipAmountOutOfRangeError(AppError):
    """The amount, or what the percent comes to on this job, is outside the tip's bounds."""

    status_code = 422
    code = "tip_amount_out_of_range"
    message = "This tip amount is not allowed."


class TipPercentNotOfferedError(AppError):
    """The percent is not one of the presets offered."""

    status_code = 422
    code = "tip_percent_not_offered"
    message = "This tip percent is not offered."


class TipEventMismatchError(Exception):
    """A tip PaymentIntent's event differs from the tip row (amount, currency or customer), or
    one of an abandoned attempt succeeded: nothing changes, and the event ends failed for staff."""


class TipRowMissingError(Exception):
    """The tip, or its job, vanished between the event's lookup and its lock; rows are never
    deleted, so the event is retried."""
