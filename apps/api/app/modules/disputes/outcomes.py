"""A job's dispute as other modules read its outcome (#472, #488; ADR 0003): whether it is
open or resolved, how, and the split an admin decided. A leaf: it imports the disputes
module's own repository only, so the jobs and requests modules can read it without a cycle."""

import uuid
from collections.abc import Collection
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.disputes.models import DisputeResolution as DisputeResolution
from app.modules.disputes.models import DisputeStatus as DisputeStatus
from app.modules.disputes.repository import DisputeRepository


@dataclass(frozen=True)
class DisputeOutcome:
    """A job's dispute: its status, and once resolved how (released, partial_release,
    refunded) with the parts decided. Plain values."""

    status: DisputeStatus
    resolution: DisputeResolution | None
    pro_release_cents: int | None
    customer_refund_cents: int | None

    @property
    def resolved(self) -> bool:
        return self.status is DisputeStatus.RESOLVED


async def dispute_outcomes(
    session: AsyncSession, job_ids: Collection[uuid.UUID]
) -> dict[uuid.UUID, DisputeOutcome]:
    """The dispute of each job among `job_ids` that has one (one per job), by job, in one
    statement; jobs without a dispute are left out."""
    rows = await DisputeRepository(session).outcomes_of_jobs(job_ids)
    return {
        job_id: DisputeOutcome(status, resolution, pro_release, customer_refund)
        for job_id, status, resolution, pro_release, customer_refund in rows
    }
