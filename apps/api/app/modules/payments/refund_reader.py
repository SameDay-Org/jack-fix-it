"""Whether a job's money went back to its customer, for another module (#273 PR A2): the tip's
transfer reads it, so a job with a refund of any kind never sends its tip by itself. Our rows
only, never a Stripe call."""

import uuid

from sqlalchemy import Select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.payments.repository import RefundRepository


async def job_has_returned_money(session: AsyncSession, job_id: uuid.UUID) -> bool:
    """Whether any refund of the job may have given money back (RefundRepository.returned_jobs).
    Read in the caller's transaction, under the job's lock when the caller holds it (a refund
    takes that lock too)."""
    return await RefundRepository(session).returned_of_job(job_id)


def returned_money_jobs() -> Select[uuid.UUID]:
    """The job (`job_id`) of every such refund, as a statement for another module's query."""
    return RefundRepository.returned_jobs()
