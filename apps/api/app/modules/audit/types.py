"""What other modules see of the audit log (#58, Vault round 1 B2; staff reads of chat
originals, #72; staff changes to a support ticket, #274): the action names, the audited entity,
the operator and the audited values, never the ORM model (ADR 0003)."""

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Final

# A JSON scalar of an audited state: ids, statuses, Stripe object ids, ISO timestamps.
AuditValue = str | int | bool | None
AuditState = Mapping[str, AuditValue]

# The longest --reason the staff scripts take: a sentence or two, not a document.
REASON_MAX_LENGTH: Final = 500


class AuditAction(StrEnum):
    PAYMENT_INTENT_ADOPT = "payment.adopt_intent"
    PAYMENT_INTENT_ALLOW_NEW = "payment.allow_new_intent"
    PAYOUT_ACCOUNT_ADOPT = "pro_profile.adopt_payout_account"
    PAYOUT_ACCOUNT_ALLOW_NEW = "pro_profile.allow_new_payout_account"
    # A staff read of a job's chat that returned at least one original (#72).
    JOB_CHAT_ORIGINALS_READ = "job.read_chat_originals"
    # A staff member moved a support ticket to another status (#274).
    SUPPORT_TICKET_SET_STATUS = "support_ticket.set_status"
    # A staff read of a pro for review: the detail shows the legal name and hands out the
    # URLs of the verification documents (#41).
    PRO_REVIEW_READ = "pro_profile.read_for_review"
    # A staff member approved or rejected a verification document (#41).
    PRO_DOCUMENT_REVIEW = "pro_document.review"
    # A staff member approved or rejected a pro profile (#41).
    PRO_PROFILE_SET_VERIFICATION = "pro_profile.set_verification"
    # A staff read of a job's transfer to its pro (#68).
    JOB_TRANSFER_READ = "job.read_transfer"
    # A staff read of a request's card: the customer's name, phone, email and address (#81).
    REQUEST_CARD_READ = "service_request.read_card"
    # A staff member took a request, or let go of one (#81).
    REQUEST_CLAIM = "service_request.claim"
    REQUEST_RELEASE = "service_request.release"
    # The BDC's actions on a request (#82): an internal note, the first contact, the category,
    # a follow-up scheduled or done.
    REQUEST_NOTE_ADD = "service_request.add_note"
    REQUEST_MARK_CONTACTED = "service_request.mark_contacted"
    REQUEST_CLASSIFY = "service_request.classify"
    REQUEST_FOLLOWUP_SCHEDULE = "service_request.schedule_followup"
    REQUEST_FOLLOWUP_DONE = "service_request.followup_done"
    # A staff read of a dispute: both sides' text and the photos' URLs (#76).
    DISPUTE_READ = "dispute.read"
    # An admin resolved a dispute: released, partly released or refunded money (#76). For a
    # refund, written when Stripe says the money is back, in the transaction that settles.
    DISPUTE_RESOLVE = "dispute.resolve"
    # An admin asked for a dispute's refund: a Stripe attempt, or a read of the refund Stripe
    # holds. Committed before Stripe is called (#433 round 1 B2).
    DISPUTE_REFUND_REQUEST = "dispute.refund_request"
    # What came of it when it did not settle the dispute: a call that failed or never
    # answered, a refund Stripe has not finished, failed or canceled (#433 round 1 B2).
    DISPUTE_REFUND_OUTCOME = "dispute.refund_outcome"
    # Staff abandoned a dispute's refund Stripe refused for good, failed or canceled, once Stripe
    # showed none that could still move money, so an admin may decide again (#434).
    DISPUTE_REFUND_ABANDON = "dispute.refund_abandon"
    # An abandon the operator confirmed that was refused, or could not finish (#450 round 1):
    # its outcome code, so a confirmed attempt never leaves no trace.
    DISPUTE_REFUND_ABANDON_REFUSED = "dispute.refund_abandon_refused"
    # A job cancelled by its own customer or pro (#69): who, from which status, the split.
    JOB_CANCEL = "job.cancel"


class AuditEntityType(StrEnum):
    PAYMENT = "payment"
    PRO_PROFILE = "pro_profile"
    PRO_DOCUMENT = "pro_document"
    JOB = "job"
    SUPPORT_TICKET = "support_ticket"
    SERVICE_REQUEST = "service_request"
    DISPUTE = "dispute"


@dataclass(frozen=True)
class AuditEntity:
    type: AuditEntityType
    id: uuid.UUID


@dataclass(frozen=True)
class Operator:
    """Who performs a staff action, and why: an active admin's user id
    (AuditService.admin_operator), checked again when the action is recorded."""

    user_id: uuid.UUID
    reason: str | None = None


class OperatorNotAdminError(Exception):
    """The operator is not (or no longer) an active admin account: nothing changes."""


class ReaderNotStaffError(Exception):
    """The reader is not (or no longer) an active agent or admin account: nothing is shown."""


class ActorNotStaffError(Exception):
    """The actor is not (or no longer) an active agent or admin account: nothing changes."""


def timestamp(value: datetime | None) -> str | None:
    """A timestamp as an audited value."""
    return None if value is None else value.isoformat()
