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


class RequestNotClassifiableError(ConflictError):
    """A category is set only while the request is received or reviewing: once dispatch took
    it (finding_pro and after), classifying would not reach the pros (#82)."""

    code = "request_not_classifiable"
    message = "This request can no longer be classified."


class InvalidOpsActionError(AppError):
    """What the schema cannot check alone in a BDC action (#82): a category that is not active,
    a follow-up due in the past or too far ahead, an assignee who is not an active agent or
    admin. The same body as any other validation error."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."


class FollowupNotFoundError(NotFoundError):
    """No follow-up with this id on this request."""

    code = "followup_not_found"
    message = "Follow-up not found."
