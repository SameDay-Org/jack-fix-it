"""The payments' part of an account deletion (#97): money still moving blocks it. Payments,
transfers and refunds are kept untouched (tax and dispute retention)."""

import uuid
from typing import Final

from sqlalchemy import Select, and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.payments.models import (
    STRIPE_REFUND_SUCCEEDED,
    Payment,
    PaymentStatus,
    Refund,
    RefundStatus,
    Transfer,
    TransferStatus,
)

# A payment that can still take money, or that the unpaid sweep has not closed yet.
OPEN_PAYMENTS: Final = frozenset(
    {PaymentStatus.REQUIRES_PAYMENT, PaymentStatus.PROCESSING, PaymentStatus.FAILED}
)
# A transfer to the pro not made yet: queued, or failed and waiting for a retry or staff.
# Reversed transfers are left to staff and never clear (needs_reversal_at), so they do not
# block. A Stripe Connect payout from the pro's balance to their bank is not tracked here.
UNSETTLED_TRANSFERS: Final = frozenset({TransferStatus.PENDING, TransferStatus.FAILED})


async def customer_has_open_payment(session: AsyncSession, customer_id: uuid.UUID) -> bool:
    statement = select(
        exists().where(Payment.customer_id == customer_id, Payment.status.in_(OPEN_PAYMENTS))
    )
    return bool(await session.scalar(statement))


async def has_unsettled_refund(session: AsyncSession, job_ids: Select[uuid.UUID]) -> bool:
    """Whether a refund on one of these jobs (a dispute's or a cancellation's) has not given
    the money back yet: the payouts' own rule (RefundRepository.unsettled_dispute_jobs),
    anything but Stripe's `succeeded` unless abandoned, or one staff must reconcile."""
    statement = select(
        exists().where(
            Refund.job_id.in_(job_ids),
            or_(
                and_(
                    Refund.stripe_status.is_distinct_from(STRIPE_REFUND_SUCCEEDED),
                    Refund.status != RefundStatus.ABANDONED,
                ),
                Refund.late_refund_seen_at.is_not(None),
            ),
        )
    )
    return bool(await session.scalar(statement))


async def pro_has_unsettled_transfer(session: AsyncSession, pro_id: uuid.UUID) -> bool:
    statement = select(
        exists().where(Transfer.pro_id == pro_id, Transfer.status.in_(UNSETTLED_TRANSFERS))
    )
    return bool(await session.scalar(statement))
