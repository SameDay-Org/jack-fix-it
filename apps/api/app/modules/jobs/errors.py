from typing import Final

from app.errors import AppError, ConflictError


class InvalidTransitionError(ConflictError):
    """The job's current status has no edge to the requested one (also for a terminal status)."""

    code = "invalid_transition"
    message = "The job cannot move to that status from its current one."


class NotOnTheWayError(ConflictError):
    """A check-in on a job that is not on the way (#63)."""

    code = "not_on_the_way"
    message = "The job is not on the way."


class CheckInRequiredError(ConflictError):
    """Work starts only after the pro checked in with the customer's arrival code (#63)."""

    code = "check_in_required"
    message = "Check in with the customer's arrival code before starting the job."


# The header that carries the tries left after a wrong arrival code: the error body keeps the
# contract's two fields (code, message).
ATTEMPTS_REMAINING_HEADER: Final = "Arrival-Code-Attempts-Remaining"


class ArrivalCodeInvalidError(AppError):
    """A wrong arrival code at check-in, with tries left (#63)."""

    status_code = 422
    code = "arrival_code_invalid"
    message = "The arrival code is not right."

    def __init__(self, remaining: int) -> None:
        super().__init__(f"The arrival code is not right. Tries left: {remaining}.")
        self.headers = {ATTEMPTS_REMAINING_HEADER: str(remaining)}


class ArrivalCodeLockedError(AppError):
    """The arrival code took too many wrong tries: it is locked until the BDC resolves it."""

    status_code = 423
    code = "arrival_code_locked"
    message = "Too many wrong arrival codes. Support has been alerted."
