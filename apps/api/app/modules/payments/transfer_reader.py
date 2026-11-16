"""Reads of a job's transfer (#68) for the people who may see it: the job's pro, as the payout
of their job, and staff, as the row.

The pro sees two states only. `pending`: the job is confirmed and the transfer is still to be
made (no row yet, or one Stripe has not made, whatever went wrong so far: an error code is
staff's, never the pro's). `created`: Stripe made the transfer. A reversed transfer shows no
payout at all: neither word would be true of it. The customer sees nothing of this.

A staff read answers with the row as stored (ids, the amount, the status, Stripe's transfer id
and the last error code; never the idempotency key, which only Stripe needs) and writes an
audit_log row first, committed before the answer: a read that cannot be audited shows nothing.
"""

import logging
import uuid
from collections.abc import Collection
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import NotFoundError
from app.modules.audit.service import AuditService
from app.modules.audit.types import AuditAction, AuditEntity, AuditEntityType
from app.modules.jobs.service import JobPayouts
from app.modules.payments.models import TransferStatus
from app.modules.payments.payout_status import PayoutStatus
from app.modules.payments.repository import TransferRepository
from app.modules.payments.schemas import JobTransferOut, TransferOut
from app.modules.pros.service import ProService
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)


_PAYOUT: Final[dict[TransferStatus, PayoutStatus | None]] = {
    TransferStatus.PENDING: PayoutStatus.PENDING,
    TransferStatus.FAILED: PayoutStatus.PENDING,
    TransferStatus.CREATED: PayoutStatus.CREATED,
    TransferStatus.REVERSED: None,
}


class TransferReader:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._transfers = TransferRepository(session)
        self._jobs = JobPayouts(session, ProService(session))

    async def payouts(self, job_ids: Collection[uuid.UUID]) -> dict[uuid.UUID, PayoutStatus | None]:
        """The payout of each job among `job_ids` that has a transfer row (None: reversed). A
        job with no row is absent: its payout is pending once it is confirmed, and nothing
        before (the caller knows the job's status)."""
        statuses = await self._transfers.statuses_of_jobs(job_ids)
        return {job_id: _PAYOUT[status] for job_id, status in statuses.items()}

    async def staff_transfer(self, staff: UserAccount, job_id: uuid.UUID) -> JobTransferOut:
        """Any job's transfer row for the BDC and admins (None before the job's first
        release); 404 for an unknown job. Read-only, and audited."""
        if not await self._jobs.exists(job_id):
            raise NotFoundError
        transfer = await self._transfers.get_of_job(job_id)
        await AuditService(self._session).record_read(
            staff.id,
            AuditAction.JOB_TRANSFER_READ,
            AuditEntity(AuditEntityType.JOB, job_id),
            {
                "transfer_id": None if transfer is None else str(transfer.id),
                "status": None if transfer is None else transfer.status.value,
            },
        )
        # Committed before the answer: an audit write that fails answers 500, so nothing is
        # shown unaudited.
        await self._session.commit()
        logger.info(
            "job_transfer_read_by_staff", extra={"job_id": str(job_id), "staff_id": str(staff.id)}
        )
        return JobTransferOut(
            transfer=None if transfer is None else TransferOut.model_validate(transfer)
        )
