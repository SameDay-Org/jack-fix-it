"""The payment status rules (#61): the single source of truth for payments.status after its
creation. PaymentReconciler (reconciliation.py) applies them from the PaymentIntent's events;
nothing else changes the status.

`succeeded` and `canceled` are terminal: any event after them changes nothing. `failed` is not:
the customer retries with the same PaymentIntent, so it may go on to processing, succeeded or
canceled. Events arrive out of order (Stripe does not order them), so a move that is not in the
table is ignored, never an error.
"""

from collections.abc import Mapping
from types import MappingProxyType
from typing import Final

from app.modules.payments.models import PaymentStatus

_S = PaymentStatus
_OPEN: Final = frozenset({_S.REQUIRES_PAYMENT, _S.PROCESSING, _S.FAILED})

# to -> the statuses a payment may reach it from.
PAYMENT_TRANSITIONS: Final[Mapping[PaymentStatus, frozenset[PaymentStatus]]] = MappingProxyType(
    {
        _S.PROCESSING: frozenset({_S.REQUIRES_PAYMENT, _S.FAILED}),
        _S.FAILED: frozenset({_S.REQUIRES_PAYMENT, _S.PROCESSING}),
        _S.SUCCEEDED: _OPEN,
        _S.CANCELED: _OPEN,
    }
)

# States with no way out.
TERMINAL_STATES: Final = frozenset(
    status
    for status in PaymentStatus
    if not any(status in sources for sources in PAYMENT_TRANSITIONS.values())
)


def allowed(from_status: PaymentStatus, to: PaymentStatus) -> bool:
    return from_status in PAYMENT_TRANSITIONS.get(to, frozenset())
