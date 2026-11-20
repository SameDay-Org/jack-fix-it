"""A job's cancellation as each side reads it with the job (#69): for the jobs module's job
views (ADR 0003). The customer reads the money split and where its refund stands; the pro reads
who cancelled, why and when, never the money or the note. Reads only, no lock."""

import uuid
from collections.abc import Collection
from datetime import timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.cancellations.repository import CancellationRepository
from app.modules.cancellations.views import CustomerJobCancellation, ProJobCancellation
from app.modules.payments.cancel_refunds import CancelRefunds, CancelRefundState


class CancellationReader:
    def __init__(self, session: AsyncSession) -> None:
        self._cancellations = CancellationRepository(session)
        # The refund's row and state only: nothing here reaches Stripe.
        self._refunds = CancelRefunds(session, None, timedelta(0))

    async def for_customer(self, job_id: uuid.UUID) -> CustomerJobCancellation | None:
        """The job's cancellation for its customer, with its refund's state; None if none."""
        row = await self._cancellations.of_job(job_id)
        if row is None:
            return None
        refund = await self._refunds.of_job(job_id)
        return CustomerJobCancellation(
            cancelled_by=row.party,
            reason_code=row.reason_code,
            cancelled_at=row.created_at,
            # The cancellation splits the customer's total exactly (app.money.cancellation_split).
            customer_total_cents=row.fee_cents + row.refund_cents,
            fee_cents=row.fee_cents,
            refund_cents=row.refund_cents,
            refund_status=CancelRefundState.NONE if refund is None else refund.state,
        )

    async def for_pro(self, job_ids: Collection[uuid.UUID]) -> dict[uuid.UUID, ProJobCancellation]:
        """The cancellations among these jobs, for their pro, by job, in one statement."""
        return {
            row.job_id: ProJobCancellation(
                cancelled_by=row.party, reason_code=row.reason_code, cancelled_at=row.created_at
            )
            for row in await self._cancellations.of_jobs(job_ids)
        }
