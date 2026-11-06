"""What other modules see of the audit log (#58, Vault round 1 B2): the action names, the
audited entity, the operator and the audited values, never the ORM model (ADR 0003)."""

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


class AuditEntityType(StrEnum):
    PAYMENT = "payment"
    PRO_PROFILE = "pro_profile"


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


def timestamp(value: datetime | None) -> str | None:
    """A timestamp as an audited value."""
    return None if value is None else value.isoformat()
