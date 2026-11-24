from app.errors import AppError, ForbiddenError, NotFoundError


class UploadForbiddenError(ForbiddenError):
    """The caller's role may not upload files for this purpose."""

    code = "upload_forbidden"
    message = "You cannot upload files for this purpose."


class UploadInvalidError(AppError):
    """One body for every invalid type, size or key, so it never says which one."""

    status_code = 422
    code = "upload_invalid"
    message = "The upload request is invalid."


class UploadNotFoundError(NotFoundError):
    """Also for a key of another user: its existence is never revealed."""

    code = "upload_not_found"
    message = "File not found."


class PendingUploadsTooLargeError(AppError):
    """The caller's uploads that nothing holds yet, with this one, would pass
    UPLOAD_PENDING_MAX_BYTES (#529). Never names a key or a path."""

    status_code = 413
    code = "pending_uploads_too_large"
    message = (
        "Your uploads waiting to be used are over the limit. Finish what you started, or wait "
        "a day for unused ones to clear, then try again."
    )


class UploadsUnavailableError(AppError):
    """The caller's pending uploads could not be counted (the storage or Redis failed): no URL
    is given rather than one that might pass the ceiling (#529, fail closed)."""

    status_code = 503
    code = "uploads_unavailable"
    message = "Uploads are unavailable right now. Try again later."
