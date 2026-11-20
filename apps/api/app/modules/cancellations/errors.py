from app.errors import AppError, ConflictError


class CancelNotAllowedError(ConflictError):
    """A cancel of a job whose work started (in progress), or that is done, confirmed, paid
    out, disputed or refunded: the customer reports a problem instead (#75). The message names
    the job's status."""

    code = "cancel_not_allowed"
    message = "This job can no longer be cancelled."

    def __init__(self, status: str) -> None:
        super().__init__(f"This job can no longer be cancelled: it is {status}.")


class CancelFeeChangedError(ConflictError):
    """The cancel named the fee its preview showed (expected_fee_cents), and cancelling now
    costs another: the pro set off since. Nothing changed; the app shows the new preview."""

    code = "cancel_fee_changed"
    message = "The cancellation fee changed since it was shown. Nothing was changed."


class IdempotencyKeyReusedError(ConflictError):
    """The caller's Idempotency-Key already cancelled with another body, or another job. Keys
    are per user: someone else's key is just a new key."""

    code = "idempotency_key_reused"
    message = "This Idempotency-Key was already used with a different cancellation."


class CancelNeedsReviewError(ConflictError):
    """The job's payment does not match the job (missing, no PaymentIntent, other frozen
    amounts), or the job has a transfer: staff look before any money moves. Nothing changed."""

    code = "cancel_needs_review"
    message = "This job needs a look by our team before it can be cancelled. Nothing was changed."


class InvalidCancelInputError(AppError):
    """A note with nothing left once cleaned (only invisible characters), or longer than the
    limit once masked. The same body as any other validation error."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."
