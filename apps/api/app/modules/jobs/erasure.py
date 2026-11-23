"""The jobs' part of an account deletion (#97): what blocks it, and the job history's points.

Jobs are financial records: they stay, untouched, and the account they name is anonymised in
place (users). Only the check-in point goes, on a deleted customer's jobs: it locates their
home (#395's rule: no identifiable point is left).
"""

import uuid
from typing import Final

from sqlalchemy import Select, exists, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.models import Job, JobEvent, JobStatus

# A customer's job in flight: the pro may still come, or the confirmation (and dispute)
# window is open.
CUSTOMER_BLOCKING: Final = frozenset(
    {JobStatus.SCHEDULED, JobStatus.ON_THE_WAY, JobStatus.IN_PROGRESS, JobStatus.COMPLETED}
)
# A pro's job in flight, or whose payout is still owed (confirmed, or disputed until released).
PRO_BLOCKING: Final = CUSTOMER_BLOCKING | {JobStatus.CONFIRMED, JobStatus.DISPUTED}


class JobErasure:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    @staticmethod
    def customer_job_ids(customer_id: uuid.UUID) -> Select[uuid.UUID]:
        """The ids of the customer's jobs, as a statement (the refunds' and disputes' checks)."""
        return select(Job.id).where(Job.customer_id == customer_id)

    @staticmethod
    def pro_job_ids(pro_id: uuid.UUID) -> Select[uuid.UUID]:
        """The ids of the pro's jobs, as a statement."""
        return select(Job.id).where(Job.pro_id == pro_id)

    @staticmethod
    def request_ids_with_a_job() -> Select[uuid.UUID]:
        """The requests a job was made for, as a statement: an accepted request with one is
        history, never cancelled (requests.erasure)."""
        return select(Job.request_id)

    @staticmethod
    def quote_ids_with_a_job() -> Select[uuid.UUID]:
        """The quotes a job was made from, as a statement: an accepted quote without one is
        still being paid (quotes.erasure)."""
        return select(Job.quote_id)

    async def customer_has_job_in_flight(self, customer_id: uuid.UUID) -> bool:
        statement = select(
            exists().where(Job.customer_id == customer_id, Job.status.in_(CUSTOMER_BLOCKING))
        )
        return bool(await self._session.scalar(statement))

    async def pro_has_job_in_flight(self, pro_id: uuid.UUID) -> bool:
        statement = select(exists().where(Job.pro_id == pro_id, Job.status.in_(PRO_BLOCKING)))
        return bool(await self._session.scalar(statement))

    async def forget_check_in_points(self, customer_id: uuid.UUID) -> int:
        """Clears the pro's check-in point from the history of the customer's jobs; how many
        events had one. The events themselves stay (a dispute's evidence)."""
        result = await self._session.execute(
            update(JobEvent)
            .where(
                JobEvent.job_id.in_(self.customer_job_ids(customer_id)),
                JobEvent.lat.is_not(None) | JobEvent.lng.is_not(None),
            )
            .values(lat=None, lng=None)
            .execution_options(synchronize_session=False)
        )
        return int(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of a write
