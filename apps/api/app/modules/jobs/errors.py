from app.errors import ConflictError


class InvalidTransitionError(ConflictError):
    """The job's current status has no edge to the requested one (also for a terminal status)."""

    code = "invalid_transition"
    message = "The job cannot move to that status from its current one."
