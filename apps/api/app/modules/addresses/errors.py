from app.errors import ConflictError, NotFoundError


class AddressNotFoundError(NotFoundError):
    """No saved address of the caller with this id. Another user's id and an unknown id answer
    the same, so no id is ever revealed."""

    code = "address_not_found"
    message = "Saved address not found."


class AddressLimitReachedError(ConflictError):
    """The caller already keeps SAVED_ADDRESSES_MAX_PER_USER addresses."""

    code = "address_limit_reached"
    message = "You have reached the maximum number of saved addresses."


class AddressLabelTakenError(ConflictError):
    """Another of the caller's addresses has this label, ignoring case."""

    code = "address_label_taken"
    message = "You already have an address with this label."
