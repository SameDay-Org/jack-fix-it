from app.errors import ConflictError, ForbiddenError


class InvalidPasswordError(ForbiddenError):
    """The confirmation password is not the account's (#97). 403, not 401: the session is fine,
    and an app must not read it as signed out."""

    code = "invalid_password"
    message = "The password is incorrect."


class StaffAccountDeletionError(ForbiddenError):
    """Agents and admins are made and removed by script (scripts/create_staff_user.py)."""

    code = "staff_account"
    message = "A staff account cannot be deleted from the app."


class AccountDeletionBlockedError(ConflictError):
    """Something of the account is still in flight: the deletion waits until it settles (#97).
    Each reason has its own code, so the app can say what to do first."""


class ActiveJobError(AccountDeletionBlockedError):
    code = "active_job"
    message = "A job is still in progress, waiting for confirmation or for its payout."


class OpenDisputeError(AccountDeletionBlockedError):
    code = "open_dispute"
    message = "A dispute is still open."


class RefundPendingError(AccountDeletionBlockedError):
    code = "refund_pending"
    message = "A refund has not reached the card yet."


class PaymentInProgressError(AccountDeletionBlockedError):
    code = "payment_in_progress"
    message = "A payment is still being made."


class PayoutPendingError(AccountDeletionBlockedError):
    code = "payout_pending"
    message = "A payout is still on its way."


class ActiveQuoteError(AccountDeletionBlockedError):
    code = "active_quote"
    message = "A quote is still open or being paid."
