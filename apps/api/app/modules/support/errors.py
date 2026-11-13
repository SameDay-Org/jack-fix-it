from app.errors import AppError, NotFoundError


class TicketNotFoundError(NotFoundError):
    """No support ticket with this id (the staff routes)."""

    code = "ticket_not_found"
    message = "Support ticket not found."


class InvalidTicketJobError(AppError):
    """A ticket about a job the writer takes no part in. An unknown job answers the same, so
    the answer never tells whether a job exists."""

    status_code = 422
    code = "invalid_job"
    message = "The job is not one of yours."


class InvalidTicketInputError(AppError):
    """What the schema cannot check alone: a bad cursor. The same body as any other validation
    error."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."
