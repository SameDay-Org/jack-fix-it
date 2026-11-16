from app.errors import AppError, ConflictError, NotFoundError


class InvalidProfileError(AppError):
    """A list with duplicates or more entries than the settings allow."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."


class InvalidMediaError(AppError):
    """The photo key is not the caller's own profile_photo upload; never says which check."""

    status_code = 422
    code = "invalid_media"
    message = "The attached media is invalid."


class InvalidCategoryError(AppError):
    status_code = 422
    code = "invalid_category"
    message = "The category is not available."


class InvalidServiceAreaError(AppError):
    status_code = 422
    code = "invalid_service_area"
    message = "The service area is not available."


class InvalidDocumentError(AppError):
    """A value the schema cannot check alone, such as an expiry date in the past."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."


class InvalidProListError(AppError):
    """What the schema cannot check alone in the staff list (#41): a bad cursor."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."


class ProNotFoundError(NotFoundError):
    """No pro profile with this id (the staff routes, #41)."""

    code = "pro_not_found"
    message = "Pro not found."


class ProDocumentNotFoundError(NotFoundError):
    """No document with this id among this pro's (the staff routes, #41)."""

    code = "document_not_found"
    message = "Document not found."


class DocumentNotPendingError(ConflictError):
    """Only a pending document is reviewed: this one has another decision already, or was
    replaced by a newer submission (#41)."""

    code = "document_not_pending"
    message = "Only a pending document can be reviewed."


class ProNotApprovableError(AppError):
    """The profile does not meet what an approval requires (#41). The message lists what is
    missing in fixed words (the blocker kinds and document types): nothing the pro wrote."""

    status_code = 422
    code = "pro_not_approvable"
    message = "The pro cannot be approved yet."
