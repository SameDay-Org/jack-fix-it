from typing import Final

from app.errors import AppError, ConflictError


class InvalidTransitionError(ConflictError):
    """The job's current status has no edge to the requested one (also for a terminal status)."""

    code = "invalid_transition"
    message = "The job cannot move to that status from its current one."


class JobNotCompletedError(ConflictError):
    """The customer confirms a job only once the pro marked it done (#66): any status but
    completed (or confirmed, which answers the job unchanged)."""

    code = "job_not_completed"
    message = "Only a job marked done and waiting for your confirmation can be confirmed."


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


class JobPhotoNotAllowedError(ConflictError):
    """Before photos while the pro is on the way or working; after photos while working (#298)."""

    code = "job_photo_not_allowed"
    message = "Photos of this kind cannot be added to the job in its current status."


class JobPhotoLimitError(ConflictError):
    """The job would hold more photos of the kind than JOB_PHOTO_MAX_PER_KIND (#298)."""

    code = "job_photo_limit"
    message = "The job cannot hold more photos of this kind."


class DuplicateJobPhotoError(ConflictError):
    """A key given twice, or one a job photo already holds (#298)."""

    code = "duplicate_photo"
    message = "This photo is already attached."


class InvalidJobPhotoError(AppError):
    """A key that is not one of the caller's own job_photo uploads (#298). Which check failed is
    not said."""

    status_code = 422
    code = "invalid_photo"
    message = "One or more photos are not valid uploads."


class JobPhotoUploadExpiredError(AppError):
    """A job_photo upload issued more than JOB_PHOTO_ATTACH_MAX_AGE_MINUTES ago, or before #298
    (no issue time in its key): the orphan sweep may be about to delete it (#298)."""

    status_code = 422
    code = "upload_expired"
    message = "One or more photos were uploaded too long ago. Upload them again."


class AfterPhotosRequiredError(ConflictError):
    """Job's done needs at least one after photo the customer can see: none yet, or all of
    them failed their privacy-safe copy (#298, epic #272)."""

    code = "after_photos_required"
    message = "Add at least one photo of the finished work before marking the job done."


class AfterPhotosProcessingError(ConflictError):
    """Job's done while the after photos' privacy-safe copies are still being made, none ready
    yet (#298): try again shortly."""

    code = "after_photos_processing"
    message = "The photos of the finished work are still processing. Try again in a moment."
