from app.errors import AppError, ConflictError


class JobNotDisputableError(ConflictError):
    """A report on a job that is not completed (any earlier status, confirmed by its customer
    or automatically, paid out, refunded, cancelled), or completed but past its dispute
    window."""

    code = "job_not_disputable"
    message = "A problem can no longer be reported on this job."


class NoDisputeError(ConflictError):
    """A pro's reply on a job with no dispute, or with a resolved one."""

    code = "no_open_dispute"
    message = "This job has no open problem report."


class AlreadyRepliedError(ConflictError):
    """A second, different reply from the pro: they answer once."""

    code = "already_replied"
    message = "You already replied to this problem report."


class IdempotencyKeyReusedError(ConflictError):
    """The customer's Idempotency-Key already made a report from another body, or on another
    job. Keys are per customer: someone else's key is just a new key."""

    code = "idempotency_key_reused"
    message = "This Idempotency-Key was already used with a different report."


class InvalidDisputeInputError(AppError):
    """What the schema cannot check alone: a text with nothing left once cleaned, photo keys
    that are not the caller's own dispute_photo uploads, too old, repeated, already attached
    or too many. The same body as any other validation error."""

    status_code = 422
    code = "validation_error"
    message = "The request is invalid."


class DisputeAlreadyResolvedError(ConflictError):
    """A resolve with another decision (or another split) than the one the dispute was resolved
    with (#76): a decision is final. The same decision again is a replay, never this."""

    code = "dispute_already_resolved"
    message = "This dispute was already resolved with another decision."


class ResolutionInProgressError(ConflictError):
    """Another resolve of this dispute is calling Stripe for its refund right now (an attempt
    stamped less than REFUND_STUCK_PENDING_MINUTES ago, with no outcome yet)."""

    code = "resolution_in_progress"
    message = "This dispute is being resolved right now. Try again in a few minutes."


class RefundAlreadyAttemptedError(ConflictError):
    """A refund of another amount was already attempted for this dispute, and the dispute is
    still open (the refund failed, or its answer was lost): Stripe may hold it, so only the
    same decision may be retried. Changing the decision is for staff after a look at Stripe."""

    code = "refund_already_attempted"
    message = "A refund was already attempted for this dispute; retry the same decision."


class RefundPendingError(ConflictError):
    """Stripe accepted the decision's refund and has not finished it (#433 round 1): the
    dispute stays open, and nothing it settles happens (no job change, no transfer, no message)
    until Stripe says the money is back. The same decision again reads the refund from Stripe
    once more and settles the dispute if it is done; Stripe's own refund events settle it too."""

    code = "refund_pending"
    message = (
        "The refund was sent and the payment provider has not finished it yet. The dispute "
        "stays open until it does; send the same decision again later to check."
    )


class RefundFailedError(ConflictError):
    """Stripe failed or canceled the decision's refund (#433 round 1): the money did not go
    back. The dispute stays open and any payout it decided stays held; staff repair it (#434)."""

    code = "refund_failed"
    message = (
        "The payment provider could not complete this refund. The dispute stays open for "
        "staff to repair."
    )


class DisputeNeedsReviewError(ConflictError):
    """The job's payment cannot be refunded as is (missing, or its frozen amounts do not match
    the job's), or Stripe holds refunds for the dispute that its row cannot be matched with.
    Nothing is created in Stripe (a retry of the same decision only looks again); staff look
    first."""

    code = "dispute_needs_review"
    message = "This dispute needs a review of its payment before it can be resolved."


class InvalidSplitError(AppError):
    """A partial release whose amount is not strictly between 0 and the pro's payout: all of it
    is a release, none of it a refund."""

    status_code = 422
    code = "invalid_split"
    message = "pro_release_cents must be more than 0 and less than the pro's payout."
