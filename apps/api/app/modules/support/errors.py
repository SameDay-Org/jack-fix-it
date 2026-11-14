from app.errors import AppError, ConflictError, NotFoundError


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


class IdempotencyKeyReusedError(ConflictError):
    """The writer's Idempotency-Key already made a ticket from another body (#380). Keys are
    per user: another user's key is never a conflict, so this reveals nothing about anyone
    else."""

    code = "idempotency_key_reused"
    message = "This Idempotency-Key was already used with a different ticket."
