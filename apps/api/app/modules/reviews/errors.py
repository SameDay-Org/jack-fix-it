from app.errors import AppError, ConflictError


class JobNotReviewableError(ConflictError):
    """A review of a job that was not confirmed: any earlier status, a disputed, refunded or
    cancelled job, or one paid out without a confirmation."""

    code = "job_not_reviewable"
    message = "This job cannot be reviewed."


class AlreadyReviewedError(ConflictError):
    """A second review of the same job by the same side."""

    code = "already_reviewed"
    message = "You already reviewed this job."


class InvalidReviewInputError(AppError):
    """What the schema cannot check alone: a rating the author's side may not give, a comment
    with nothing left after cleaning. The same body as any other validation error."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."
