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
