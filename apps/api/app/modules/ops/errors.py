from app.errors import AppError, ConflictError, NotFoundError


class InvalidQueueQueryError(AppError):
    """What the schema cannot check alone in the queue's list: a bad cursor."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."


class QueueRequestNotFoundError(NotFoundError):
    """No request with this id (the staff routes)."""

    code = "request_not_found"
    message = "Request not found."


class RequestHeldError(ConflictError):
    """Another staff member holds the request: it is neither taken from them nor released by
    someone else (an admin may release it)."""

    code = "request_held"
    message = "Another team member holds this request."
