"""The tips' part of an account deletion (#97, #590 round 1): a tip whose money is still moving
blocks it, as a payment's or a transfer's does (payments.erasure). Tips are kept untouched.

A tip keeps its own state on its row (status for the customer's PaymentIntent, transfer_status
for the transfer of the whole tip to the pro), so the payments' reads never see it. Each read
below is one statement over the tips table: a webhook that moves a tip on meanwhile is seen in
one state or the next, and both block where they must.
"""

import uuid
from typing import Final

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.tips.models import (
    PAYOUTS_NOT_ENABLED,
    PRO_NOT_APPROVED,
    Tip,
    TipStatus,
    TipTransferStatus,
)

# A tip still being paid: its PaymentIntent can still take the customer's money (requires
# payment, or failed and confirmable again, until the unpaid sweep closes it) or is taking it
# (processing, a bank step). The payments' own set (payments.erasure.OPEN_PAYMENTS).
BEING_PAID: Final = frozenset({TipStatus.REQUIRES_PAYMENT, TipStatus.PROCESSING, TipStatus.FAILED})
# A paid tip's transfer to the pro not made yet: not started, under way, or failed (tried
# again). Made (created, paid) is settled; reversed is staff's and never clears, as a job's
# reversed transfer (payments.erasure.UNSETTLED_TRANSFERS).
OWED_TRANSFERS: Final = frozenset(
    {TipTransferStatus.NONE, TipTransferStatus.PENDING, TipTransferStatus.FAILED}
)
# The hold codes of a held tip that waits for the pro's own payout setup: the sweep releases it
# once they can be paid (tips.models.WAITING_CODES), which needs a sign-in a deleted pro no
# longer has. Every other hold code is staff's, never released by itself: it does not block.
#
# PRO_NOT_APPROVED is NOT DECIDED (#590 round 1, the Vault's question, for Cesar): blocking it
# means a pro who is never approved again can never delete while such a tip waits. Until he
# decides it blocks, because a refused deletion can be asked again later and a deletion cannot
# be undone. To let it go, remove it here and flip
# tests/test_account_deletion.py::PRO_NOT_APPROVED_BLOCKS.
UNDECIDED_HOLD_CODES: Final = frozenset({PRO_NOT_APPROVED})
WAITING_FOR_THE_PRO: Final = frozenset({PAYOUTS_NOT_ENABLED}) | UNDECIDED_HOLD_CODES


async def customer_has_tip_being_paid(session: AsyncSession, customer_id: uuid.UUID) -> bool:
    """Whether a tip of the customer (a user id) can still take, or is taking, their money."""
    statement = select(exists().where(Tip.customer_id == customer_id, Tip.status.in_(BEING_PAID)))
    return bool(await session.scalar(statement))


async def pro_has_tip_owed(session: AsyncSession, pro_id: uuid.UUID) -> bool:
    """Whether a tip on the pro's jobs (a pro profile id) is still on its way to them: being
    paid by the customer, or paid with its transfer not made yet or held for their payout
    setup (see the sets above)."""
    owed = and_(
        Tip.status == TipStatus.SUCCEEDED,
        or_(
            Tip.transfer_status.in_(OWED_TRANSFERS),
            and_(
                Tip.transfer_status == TipTransferStatus.HELD,
                Tip.transfer_last_error_code.in_(WAITING_FOR_THE_PRO),
            ),
        ),
    )
    statement = select(exists().where(Tip.pro_id == pro_id, or_(Tip.status.in_(BEING_PAID), owed)))
    return bool(await session.scalar(statement))
