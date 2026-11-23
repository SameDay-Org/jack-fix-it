from app.errors import ConflictError


class TermsNotCurrentError(ConflictError):
    """The kind and version are not a document in force for the caller (#97): another version,
    a kind their role does not accept, or a kind with no version published yet."""

    code = "terms_not_current"
    message = "This document version is not the one in force for this account."
