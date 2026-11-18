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
    # A staff read of a dispute: both sides' text and the photos' URLs (#76).
    DISPUTE_READ = "dispute.read"
    # An admin resolved a dispute: released, partly released or refunded money (#76).
    DISPUTE_RESOLVE = "dispute.resolve"


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
