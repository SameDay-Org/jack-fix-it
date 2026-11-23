"""The tips' part of an account deletion (#97, #590 rounds 1 and 2): a tip whose money is still
moving blocks it, as a payment's or a transfer's does (payments.erasure). Tips are kept
untouched.

A tip keeps its own state on its row (status for the customer's PaymentIntent, transfer_status
for the transfer of the whole tip to the pro), so the payments' reads never see it. Each read
below is one statement over the tips table: a webhook that moves a tip on meanwhile is seen in
one state or the next, and both block where they must.

A state blocks only while something will still move it on by itself: a tip that nothing ever
closes or sends (it is staff's, or it took no money) never blocks, or the account could never
be deleted (#590 round 2).
"""

import uuid
from typing import Final

from sqlalchemy import ColumnElement, and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.tips.models import (
    UNPAID_STATUSES,
    WAITING_CODES,
    Tip,
    TipStatus,
    TipTransferStatus,
)
from app.modules.tips.transfers import blocked_jobs

# A paid tip's transfer to the pro not made yet: not started, under way, or failed (tried
# again). Made (created, paid) is settled; reversed is staff's and never clears, as a job's
# reversed transfer (payments.erasure.UNSETTLED_TRANSFERS).
OWED_TRANSFERS: Final = frozenset(
    {TipTransferStatus.NONE, TipTransferStatus.PENDING, TipTransferStatus.FAILED}
)
# A held tip blocks while it waits for the pro's own payout setup (tips.models.WAITING_CODES:
# payouts_not_enabled and pro_not_approved, Cesar's decision on #590): the sweep releases it
# once they can be paid, which needs a sign-in a deleted pro no longer has. Every other hold
# code is staff's, never released by itself: it does not block.


def _being_paid() -> ColumnElement[bool]:
    """A tip still being paid: processing (a bank step, Stripe may still take the money), or
    waiting for the customer (requires_payment, or failed and confirmable again) on a stored
    PaymentIntent, which the unpaid sweep cancels in time (TipRepository's unpaid read). One
    waiting with no stored PaymentIntent (Stripe refused the create, or its answer was lost)
    can take no money, and nothing closes it once the tip window has closed: it never blocks."""
    return or_(
        Tip.status == TipStatus.PROCESSING,
        and_(Tip.status.in_(UNPAID_STATUSES), Tip.stripe_payment_intent_id.is_not(None)),
    )


def _owed_to_the_pro() -> ColumnElement[bool]:
    """A paid tip the transfer sweep will still send to the pro by itself
    (TipTransferRepository.due, but for the pro's payout setup, which it waits for): never
    flagged for staff, on a job with no dispute or refund, its transfer not made yet or held
    for the pro's payout setup. The rest is staff's: it never blocks."""
    blocked = blocked_jobs()
    return and_(
        Tip.status == TipStatus.SUCCEEDED,
        Tip.late_success_at.is_(None),
        Tip.job_id.not_in(select(blocked.c.job_id)),
        or_(
            Tip.transfer_status.in_(OWED_TRANSFERS),
            and_(
                Tip.transfer_status == TipTransferStatus.HELD,
                Tip.transfer_last_error_code.in_(WAITING_CODES),
            ),
        ),
    )


async def customer_has_tip_being_paid(session: AsyncSession, customer_id: uuid.UUID) -> bool:
    """Whether a tip of the customer (a user id) is still being paid (_being_paid)."""
    statement = select(exists().where(Tip.customer_id == customer_id, _being_paid()))
    return bool(await session.scalar(statement))


async def pro_has_tip_owed(session: AsyncSession, pro_id: uuid.UUID) -> bool:
    """Whether a tip on the pro's jobs (a pro profile id) is still on its way to them: being
    paid by the customer, or paid and still to be sent (_being_paid, _owed_to_the_pro)."""
    statement = select(exists().where(Tip.pro_id == pro_id, or_(_being_paid(), _owed_to_the_pro())))
    return bool(await session.scalar(statement))
