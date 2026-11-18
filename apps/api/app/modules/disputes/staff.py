"""Disputes for staff (#76): the list and a dispute in full, for the BDC's agents and admins.

The list shows what triage needs: the request's public code, the reason, the money (the
customer's total, the pro's frozen payout and, once resolved, what each side got), the parties'
first names and when it was opened (its age). Oldest first, at most REQUEST_LIST_MAX_LIMIT.

A dispute in full adds both sides' text as stored (masked), the photos' safe copies only
(signed for DOWNLOAD_URL_TTL_SECONDS), the job's history, its payment, refund and transfer. Each
such read writes an audit_log row first (dispute.read), committed before the answer: a read that
cannot be audited shows nothing. Reads only: resolving is resolution.py's, for admins.
"""

import logging
import uuid
from collections.abc import Mapping

from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import ForbiddenError, NotFoundError
from app.integrations.storage import StorageProvider
from app.modules.audit.service import AuditService
from app.modules.audit.types import (
    AuditAction,
    AuditEntity,
    AuditEntityType,
    ReaderNotStaffError,
)
from app.modules.disputes.models import Dispute, DisputeStatus
from app.modules.disputes.photos import DisputePhotoSigner
from app.modules.disputes.repository import DisputePhotoRepository, DisputeRepository
from app.modules.disputes.staff_schemas import (
    StaffDisputeList,
    StaffDisputeOut,
    StaffDisputeSummary,
    StaffJobEventOut,
)
from app.modules.jobs.service import JobDisputeFacts, JobDisputes, JobStaffReader
from app.modules.payments.refunds import PaymentFacts, RefundLedger
from app.modules.payments.transfer_reader import TransferReader
from app.modules.pros.service import ProService
from app.modules.requests.service import CustomerRequestReader
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)


class DisputeStaffReader:
    def __init__(
        self,
        session: AsyncSession,
        storage: StorageProvider,
        photo_url_ttl_seconds: int,
        list_default_limit: int,
        list_max_limit: int,
    ) -> None:
        self._session = session
        self._disputes = DisputeRepository(session)
        self._photos = DisputePhotoRepository(session)
        self._jobs = JobDisputes(session, ProService(session))
        self._job_history = JobStaffReader(session)
        self._requests = CustomerRequestReader(session)
        self._ledger = RefundLedger(session)
        self._transfers = TransferReader(session)
        self._users = UserService(session)
        self._audit = AuditService(session)
        self._signer = DisputePhotoSigner(storage, photo_url_ttl_seconds)
        self._list_default_limit = list_default_limit
        self._list_max_limit = list_max_limit

    async def listed(self, status: DisputeStatus | None, limit: int | None) -> StaffDisputeList:
        """Disputes of `status` (or any), oldest first. `limit` above the maximum is capped.
        Five statements, whatever the page's size."""
        size = min(limit or self._list_default_limit, self._list_max_limit)
        disputes = await self._disputes.listed(status, size)
        jobs = await self._jobs.read_many({dispute.job_id for dispute in disputes})
        codes = await self._requests.public_codes({job.request_id for job in jobs.values()})
        payments = await self._ledger.payments_of_quotes({job.quote_id for job in jobs.values()})
        names = await self._users.first_names(
            {job.customer_id for job in jobs.values()} | {job.pro_user_id for job in jobs.values()}
        )
        items = [
            _summary(
                dispute,
                jobs[dispute.job_id],
                codes,
                payments.get(jobs[dispute.job_id].quote_id),
                names,
            )
            for dispute in disputes
        ]
        await self._session.rollback()
        return StaffDisputeList(disputes=items)

    async def detail(self, staff: UserAccount, dispute_id: uuid.UUID) -> StaffDisputeOut:
        """The dispute in full; 404 for an unknown one. Audited before it is answered."""
        dispute = await self._disputes.get(dispute_id)
        if dispute is None:
            raise NotFoundError
        job = (await self._jobs.read_many([dispute.job_id]))[dispute.job_id]
        codes = await self._requests.public_codes([job.request_id])
        payment = await self._ledger.payment_of_quote(job.quote_id)
        summary_of_payment = await self._ledger.payment_summary(job.quote_id)
        names = await self._users.first_names({job.customer_id, job.pro_user_id})
        photos, pending = self._signer.for_other_side(await self._photos.of_dispute(dispute.id))
        history = await self._job_history.of_request(job.request_id)
        refund = await self._ledger.of_dispute(dispute.id)
        transfer = await self._transfers.of_job(job.job_id)
        summary = _summary(dispute, job, codes, payment, names)
        # Built before the commit below: nothing is read from a row after it.
        out = StaffDisputeOut(
            **summary.model_dump(),
            description=dispute.description,
            pro_reply=dispute.pro_reply,
            pro_replied_at=dispute.pro_replied_at,
            resolution_note=dispute.resolution_note,
            resolved_by=dispute.resolved_by,
            photos=photos,
            photos_pending=pending,
            events=[
                StaffJobEventOut(
                    type=event.type,
                    from_status=event.from_status,
                    to_status=event.to_status,
                    by_system=event.by_system,
                    created_at=event.created_at,
                )
                for event in (() if history is None else history.events)
            ],
            payment=summary_of_payment,
            refund=refund,
            transfer=transfer,
        )
        try:
            await self._audit.record_read(
                staff.id,
                AuditAction.DISPUTE_READ,
                AuditEntity(AuditEntityType.DISPUTE, dispute_id),
                {"job_id": str(job.job_id), "photos": len(photos)},
            )
        except ReaderNotStaffError:
            await self._session.rollback()
            raise ForbiddenError from None
        # Committed before the answer: an audit write that fails answers 500, so nothing is
        # shown unaudited.
        await self._session.commit()
        logger.info(
            "dispute_read_by_staff",
            extra={"dispute_id": str(dispute_id), "staff_id": str(staff.id)},
        )
        return out


def _summary(
    dispute: Dispute,
    job: JobDisputeFacts,
    codes: Mapping[uuid.UUID, str],
    payment: PaymentFacts | None,
    names: Mapping[uuid.UUID, str | None],
) -> StaffDisputeSummary:
    return StaffDisputeSummary(
        id=dispute.id,
        job_id=dispute.job_id,
        public_code=codes[job.request_id],
        status=dispute.status,
        reason_code=dispute.reason_code,
        resolution=dispute.resolution,
        job_status=job.status,
        customer_first_name=names.get(job.customer_id),
        pro_first_name=names.get(job.pro_user_id),
        customer_total_cents=None if payment is None else payment.customer_total_cents,
        pro_payout_cents=job.pro_payout_cents,
        pro_release_cents=dispute.pro_release_cents,
        customer_refund_cents=dispute.customer_refund_cents,
        currency=None if payment is None else payment.currency,
        opened_at=dispute.created_at,
        resolved_at=dispute.resolved_at,
    )
