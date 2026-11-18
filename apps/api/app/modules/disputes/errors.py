from app.errors import AppError, ConflictError


class JobNotDisputableError(ConflictError):
    """A report on a job that is not completed (any earlier status, confirmed by its customer
    or automatically, paid out, refunded, cancelled), or completed but past its dispute
    window."""

    code = "job_not_disputable"
    message = "A problem can no longer be reported on this job."


class NoDisputeError(ConflictError):
    """A pro's reply on a job with no dispute, or with a resolved one."""

    code = "no_open_dispute"
    message = "This job has no open problem report."


class AlreadyRepliedError(ConflictError):
    """A second, different reply from the pro: they answer once."""

    code = "already_replied"
    message = "You already replied to this problem report."


class IdempotencyKeyReusedError(ConflictError):
    """The customer's Idempotency-Key already made a report from another body, or on another
    job. Keys are per customer: someone else's key is just a new key."""

    code = "idempotency_key_reused"
    message = "This Idempotency-Key was already used with a different report."


class InvalidDisputeInputError(AppError):
    """What the schema cannot check alone: a text with nothing left once cleaned, photo keys
    that are not the caller's own dispute_photo uploads, too old, repeated, already attached
    or too many. The same body as any other validation error."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."
