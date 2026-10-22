"""The request state machine's rules: the single source of truth (D12.1 requests, #160).

From docs/glossary.md "Internal request states", plus the four edges Cesar approved on
2026-10-22 (#160 follow-up). RequestStateMachine (state_machine.py) applies them; nothing else
changes service_requests.status or duplicates this table. `expired` and `cancelled` are the
terminal states; `accepted` is not (payment failed, or cancelled before paying).
"""

from collections.abc import Mapping
from enum import StrEnum
from types import MappingProxyType
from typing import Final

from app.modules.requests.models import RequestStatus


class ActorKind(StrEnum):
    CUSTOMER = "customer"  # the request's own customer
    STAFF = "staff"  # an agent or an admin (BDC)
    SYSTEM = "system"  # workers: dispatch (#48), quotes (#50), expiry (#51)


_S = RequestStatus
_A = ActorKind
_BEFORE_ACCEPTANCE = (_S.RECEIVED, _S.REVIEWING, _S.FINDING_PRO, _S.QUOTE_READY)

# (from, to) -> who may move a request along that edge. Anything not listed is a 409. Pros
# never move a request: they act on quotes and jobs.
TRANSITIONS: Final[Mapping[tuple[RequestStatus, RequestStatus], frozenset[ActorKind]]] = (
    MappingProxyType(
        {
            # Staff take a request for review; an uncategorized one goes on its own (#48).
            (_S.RECEIVED, _S.REVIEWING): frozenset({_A.SYSTEM, _A.STAFF}),
            (_S.RECEIVED, _S.FINDING_PRO): frozenset({_A.SYSTEM, _A.STAFF}),
            (_S.REVIEWING, _S.FINDING_PRO): frozenset({_A.SYSTEM, _A.STAFF}),
            # The first quote arrived.
            (_S.FINDING_PRO, _S.QUOTE_READY): frozenset({_A.SYSTEM}),
            # The customer accepts a quote; once paid, the job's state machine takes over.
            (_S.QUOTE_READY, _S.ACCEPTED): frozenset({_A.CUSTOMER}),
            (_S.FINDING_PRO, _S.EXPIRED): frozenset({_A.SYSTEM}),
            (_S.QUOTE_READY, _S.EXPIRED): frozenset({_A.SYSTEM}),
            **{
                (status, _S.CANCELLED): frozenset({_A.CUSTOMER, _A.STAFF})
                for status in _BEFORE_ACCEPTANCE
            },
            # Every quote was withdrawn or expired before the request's own deadline: back out.
            (_S.QUOTE_READY, _S.FINDING_PRO): frozenset({_A.SYSTEM}),
            # The payment failed (#61): the customer can retry or pick another quote.
            (_S.ACCEPTED, _S.QUOTE_READY): frozenset({_A.SYSTEM}),
            # The customer abandons before paying, or staff close it: no money has moved.
            (_S.ACCEPTED, _S.CANCELLED): frozenset({_A.CUSTOMER, _A.STAFF}),
            # The BDC pulls the request back to reclassify it.
            (_S.FINDING_PRO, _S.REVIEWING): frozenset({_A.STAFF}),
        }
    )
)

# States with no way out: expired and cancelled.
TERMINAL_STATES: Final = frozenset(
    status for status in RequestStatus if not any(source is status for source, _ in TRANSITIONS)
)
