"""A job's payout as its pro sees it (#68). A leaf (no imports from the app), so the jobs
module's schemas can name it without importing the transfer code, which reads jobs."""

from enum import StrEnum


class PayoutStatus(StrEnum):
    # The job is confirmed and the transfer to the pro's account is still to be made.
    PENDING = "pending"
    # Stripe made the transfer.
    CREATED = "created"
