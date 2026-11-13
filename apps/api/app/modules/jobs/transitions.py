"""The job state machine's rules: the single source of truth (D12.1, #60).

From the plan's p. 12 diagram and docs/glossary.md "Internal job states". JobStateMachine
(service.py) applies them; nothing else changes jobs.status or duplicates these tables.
"""

from collections.abc import Mapping
from enum import StrEnum
from types import MappingProxyType
from typing import Final

from app.modules.jobs.models import JobStatus


class ActorKind(StrEnum):
    CUSTOMER = "customer"  # the job's own customer
    PRO = "pro"  # the job's own pro
    ADMIN = "admin"
    SYSTEM = "system"  # workers: 48 h auto-confirm (#67), transfers (#68)


_S = JobStatus
_A = ActorKind

# (from, to) -> who may move a job along that edge. Anything not listed is a 409.
TRANSITIONS: Final[Mapping[tuple[JobStatus, JobStatus], frozenset[ActorKind]]] = MappingProxyType(
    {
        (_S.SCHEDULED, _S.ON_THE_WAY): frozenset({_A.PRO}),
        # The diagram goes from Agendado straight to Em execução too.
        (_S.SCHEDULED, _S.IN_PROGRESS): frozenset({_A.PRO}),
        (_S.ON_THE_WAY, _S.IN_PROGRESS): frozenset({_A.PRO}),
        (_S.IN_PROGRESS, _S.COMPLETED): frozenset({_A.PRO}),
        # The customer confirms, or the system after 48 h without an answer.
        (_S.COMPLETED, _S.CONFIRMED): frozenset({_A.CUSTOMER, _A.SYSTEM}),
        (_S.COMPLETED, _S.DISPUTED): frozenset({_A.CUSTOMER}),
        (_S.CONFIRMED, _S.PAID_OUT): frozenset({_A.SYSTEM}),
        # An admin decides a dispute: release (fully or partially) or refund fully.
        (_S.DISPUTED, _S.PAID_OUT): frozenset({_A.ADMIN}),
        (_S.DISPUTED, _S.REFUNDED): frozenset({_A.ADMIN}),
        # Only the move itself; when cancelling is allowed, and what is refunded, is #69 (#3).
        (_S.SCHEDULED, _S.CANCELLED): frozenset({_A.CUSTOMER, _A.PRO, _A.ADMIN}),
        (_S.ON_THE_WAY, _S.CANCELLED): frozenset({_A.CUSTOMER, _A.PRO, _A.ADMIN}),
    }
)

# States with no way out.
TERMINAL_STATES: Final = frozenset(
    status for status in JobStatus if not any(source is status for source, _ in TRANSITIONS)
)

# While the customer and the pro may still write in the job's chat (#71): from the payment to
# the job's end. A disputed job stays open, so both sides can still talk while an admin decides.
# Once confirmed, paid out, refunded or cancelled the chat is read-only (Builder decision, to be
# confirmed by Cesar).
CHAT_OPEN: Final = frozenset(
    {_S.SCHEDULED, _S.ON_THE_WAY, _S.IN_PROGRESS, _S.COMPLETED, _S.DISPUTED}
)

# While a job may be reviewed by both sides (#77): once it was confirmed, by the customer or by
# the 48 h auto-confirm. A confirmed job only ever moves to paid_out, which keeps it
# reviewable; paid_out is also where an admin's release of a dispute ends, and that job was
# never confirmed (no confirmed_at): is_reviewable tells the two apart.
REVIEWABLE: Final = frozenset({_S.CONFIRMED, _S.PAID_OUT})

# What the customer sees: the i18n keys of docs/glossary.md "Customer-visible statuses".
CUSTOMER_STATUS: Final[Mapping[JobStatus, str]] = MappingProxyType(
    {
        _S.SCHEDULED: "customerStatus.scheduled",
        _S.ON_THE_WAY: "customerStatus.professionalOnTheWay",
        _S.IN_PROGRESS: "customerStatus.inProgress",
        _S.COMPLETED: "customerStatus.waitingForConfirmation",
        _S.CONFIRMED: "customerStatus.completed",
        _S.PAID_OUT: "customerStatus.completed",
        _S.DISPUTED: "customerStatus.needsAttention",
        # Refunded reads as cancelled to the customer (Cesar, 2026-10-21).
        _S.REFUNDED: "customerStatus.cancelled",
        _S.CANCELLED: "customerStatus.cancelled",
    }
)
