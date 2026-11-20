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


class CategoryInactiveError(AppError):
    """A classification to a category that is not active (#82): its own code, so the panel
    says what to fix (82-web-plan.md section 5)."""

    status_code = 422
    code = "category_inactive"
    message = "This category is not active."


class FollowupDueOutOfRangeError(AppError):
    """A follow-up due in the past, or more than OPS_FOLLOWUP_MAX_DAYS ahead (#82)."""

    status_code = 422
    code = "followup_due_out_of_range"
    message = "A follow-up is due between now and the furthest day allowed."


class AssigneeNotStaffError(AppError):
    """A follow-up given to someone who is not an active agent or admin (#82)."""

    status_code = 422
    code = "assignee_not_staff"
    message = "A follow-up goes to an active agent or admin."


class FollowupNotFoundError(NotFoundError):
    """No follow-up with this id on this request."""

    code = "followup_not_found"
    message = "Follow-up not found."
