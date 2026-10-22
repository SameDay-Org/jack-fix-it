from app.errors import AppError, ConflictError


class InvalidRequestError(AppError):
    """A value the schema cannot check alone: a past date, oversized intake answers, a bad
    cursor. The same body as any other validation error."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."


class InvalidCategoryError(AppError):
    status_code = 422
    code = "invalid_category"
    message = "The category is not available."


class InvalidIntakeAnswersError(AppError):
    """Answers that do not fit the category's questions. Never says which value failed."""

    status_code = 422
    code = "invalid_intake_answers"
    message = "The answers to the service questions are invalid."


class InvalidMediaError(AppError):
    """One body for every media problem, so it never says which key, or whose, failed."""

    status_code = 422
    code = "invalid_media"
    message = "The attached media is invalid."


class ZipNotServedError(AppError):
    """The address is outside the active service areas: the client offers the waitlist."""

    status_code = 422
    code = "zip_not_served"
    message = "This ZIP code is not served yet."


class InvalidTransitionError(ConflictError):
    """The request's current status has no edge to the requested one (also for a terminal
    status). The same code as the jobs' error: one invalid_transition for every state machine."""

    code = "invalid_transition"
    message = "The request cannot move to that status from its current one."
