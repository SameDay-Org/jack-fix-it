"""Report a problem (#75; D13.1): the customer disputes a completed job inside its window, and
the job's money is held until an admin resolves it (#76).

- Who: the job's customer reports (a pro gets 403 at the route, any other customer and an
  unknown job the same 404). Both sides read it; the pro answers once.
- When (Foreman 2026-11-17): the job is completed and the report comes before completed_at plus
  DISPUTE_WINDOW_HOURS (unset: JOB_AUTO_CONFIRM_AFTER_HOURS, never more). That is the
  confirmation window: once the job is confirmed, by the customer or by the system, the customer
  goes to support instead. Anything else is 409 `job_not_disputable`.
- Once: one dispute per job (UNIQUE job_id). The report runs under the job's row lock, so a
  second report, one after the other or at the same time, finds the first and returns it
  unchanged (200; 201 when created), whatever its body.
- Idempotency-Key (the pattern of POST /v1/requests, app.idempotency): optional, a UUID the app
  makes once per draft. Stored with the body's fingerprint; a repeat with the same body answers
  the dispute it made, before any check that depends on the time (a retry after the photo keys
  aged still gets its report). The same key with another body, or on another job, is 409
  `idempotency_key_reused`. Keys are per customer and never expire: one dispute per job.
- Atomic: the dispute, its photos and the job's move completed -> disputed (through
  JobStateMachine, the customer as actor, one job_events row) commit together or not at all.
  The disputed job is then held: the auto-confirm reads completed jobs only, release reads
  confirmed ones, and has_open_hold (payments.transfers) refuses any job with an open dispute.
- After the commit: the pro is pushed (job_disputed) and the photos' safe copies are queued; a
  queue failure is logged with ids and never fails the report. The ops queue shows the request
  under `problems` (#81) from the job's status.
- Text: the description and the pro's reply go through the chat's contact redaction
  (app.redaction.redact_contacts); only the masked text is stored, and never logged.
- Photos: the customer's own dispute_photo uploads, issued at most
  JOB_PHOTO_ATTACH_MAX_AGE_MINUTES before (the orphan sweep's disjoint window, uploads/orphans.py),
  at most DISPUTE_PHOTO_MAX_COUNT, each attached once. The pro is shown the safe copies only.
- Neither view names the other side: no contact detail, no user id.
"""

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from redis.exceptions import RedisError
from sqlalchemy import Subquery
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db import violated_constraint
from app.errors import NotFoundError
from app.idempotency import body_fingerprint, same_body
from app.integrations.storage import StorageProvider
from app.modules.disputes.errors import (
    AlreadyRepliedError,
    IdempotencyKeyReusedError,
    InvalidDisputeInputError,
    JobNotDisputableError,
    NoDisputeError,
)
from app.modules.disputes.models import (
    IDEMPOTENCY_KEY_INDEX,
    ONE_PER_JOB,
    TEXT_MAX_LENGTH,
    Dispute,
    DisputePhoto,
    DisputeStatus,
)
from app.modules.disputes.photos import DisputePhotoSigner, enqueue_dispute_photo_sanitize
from app.modules.disputes.repository import DisputePhotoRepository, DisputeRepository
from app.modules.disputes.schemas import (
    CustomerDisputeOut,
    CustomerDisputeView,
    DisputeIn,
    DisputeReplyIn,
    ProDisputeOut,
    ProDisputeView,
)
from app.modules.jobs.service import JobDisputeFacts, JobDisputes, JobStatus
from app.modules.notifications.events import push_job_disputed
from app.modules.pros.service import ProService
from app.modules.requests.service import CustomerRequestReader
from app.modules.uploads.keys import owned_upload, upload_issued_at
from app.modules.uploads.schemas import UploadPurpose
from app.modules.users.types import UserAccount
from app.queue import JobQueue
from app.redaction import redact_contacts

logger = logging.getLogger(__name__)


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class _Idempotency:
    key: uuid.UUID
    fingerprint: str


@dataclass(frozen=True)
class DisputeConfig:
    # How long after the job is marked done a problem may be reported.
    window: timedelta
    photo_max: int
    photo_attach_max_age: timedelta
    photo_url_ttl_seconds: int
    enqueue_timeout_seconds: float

    @classmethod
    def from_settings(cls, settings: Settings) -> "DisputeConfig":
        hours = settings.dispute_window_hours or settings.job_auto_confirm_after_hours
        return cls(
            window=timedelta(hours=hours),
            photo_max=settings.dispute_photo_max_count,
            photo_attach_max_age=timedelta(minutes=settings.job_photo_attach_max_age_minutes),
            photo_url_ttl_seconds=settings.download_url_ttl_seconds,
            enqueue_timeout_seconds=settings.job_enqueue_timeout_seconds,
        )


async def has_open_dispute(session: AsyncSession, job_id: uuid.UUID) -> bool:
    """Whether the job has an open dispute: its money is held (payments.transfers)."""
    return await DisputeRepository(session).is_open_for(job_id)


def open_dispute_jobs() -> Subquery:
    """The job (`job_id`) of every open dispute, as a subquery: the transfer sweep leaves
    those jobs out in its own query."""
    return DisputeRepository.open_jobs()


@dataclass(frozen=True)
class ReleasedDispute:
    """A job's dispute resolved with a release (#76), as its transfer reads it: how much of the
    pro's payout to pay, and the admin whose decision the transfer carries out."""

    pro_release_cents: int
    resolved_by: uuid.UUID


async def released_dispute(session: AsyncSession, job_id: uuid.UUID) -> ReleasedDispute | None:
    """The job's dispute when an admin resolved it with a release, full or partial; None
    otherwise (no dispute, still open, or refunded)."""
    dispute = await DisputeRepository(session).released_of_job(job_id)
    if dispute is None or dispute.pro_release_cents is None or dispute.resolved_by is None:
        return None
    return ReleasedDispute(
        pro_release_cents=dispute.pro_release_cents, resolved_by=dispute.resolved_by
    )


def released_dispute_jobs() -> Subquery:
    """The job (`job_id`) of every dispute resolved with a release, as a subquery: the
    transfer sweep reads those jobs as well as the confirmed ones (#76)."""
    return DisputeRepository.released_jobs()


class DisputeService:
    def __init__(
        self,
        session: AsyncSession,
        config: DisputeConfig,
        storage: StorageProvider,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._session = session
        self._config = config
        self._clock = clock
        self._disputes = DisputeRepository(session)
        self._photos = DisputePhotoRepository(session)
        pros = ProService(session)
        self._jobs = JobDisputes(session, pros)
        self._requests = CustomerRequestReader(session)
        self._signer = DisputePhotoSigner(storage, config.photo_url_ttl_seconds)

    async def report(
        self,
        user: UserAccount,
        job_id: uuid.UUID,
        data: DisputeIn,
        queue: JobQueue,
        idempotency_key: uuid.UUID | None = None,
    ) -> tuple[CustomerDisputeView, bool]:
        """The customer's report on their job (see the module doc), and whether it was created
        now (False: an earlier report, returned unchanged). Commits."""
        keys = data.photo_keys
        # The body's own checks before any query: a huge body never reaches the database. None
        # depends on the time, so a retry of a report that was made passes them again.
        self._check_photo_key_shapes(user, keys)
        description = _clean(data.description)
        idempotency = (
            None
            if idempotency_key is None
            else _Idempotency(key=idempotency_key, fingerprint=_fingerprint(data))
        )
        # The caller's own job first, unlocked: nobody else's job row is ever locked here.
        party = await self._jobs.of_party(user.id, job_id)
        if party is None or party.customer_id != user.id:
            raise NotFoundError
        job = await self._jobs.locked(job_id)
        if job is None:  # pragma: no cover - jobs are never deleted
            raise NotFoundError
        if idempotency is not None:
            keyed = await self._disputes.by_idempotency_key(user.id, idempotency.key)
            if keyed is not None and (
                keyed.job_id != job.job_id
                or not same_body(keyed.idempotency_fingerprint, idempotency.fingerprint)
            ):
                logger.info("dispute_idempotency_key_reused", extra={"job_id": str(job_id)})
                raise IdempotencyKeyReusedError
        existing = await self._disputes.of_job(job.job_id)
        if existing is not None:
            await self._session.commit()  # nothing changed: ends the transaction and its lock
            return await self.customer_view(user, job_id), False
        if not self._disputable(job):
            raise JobNotDisputableError
        self._check_photo_key_ages(keys)
        if keys and await self._photos.held_keys(keys):
            raise InvalidDisputeInputError
        dispute = Dispute(
            job_id=job.job_id,
            opened_by=user.id,
            reason_code=data.reason_code,
            description=description,
            idempotency_key=idempotency and idempotency.key,
            idempotency_fingerprint=idempotency and idempotency.fingerprint,
        )
        now = self._clock()
        try:
            await self._disputes.add(dispute)
            photos = [
                DisputePhoto(
                    dispute_id=dispute.id,
                    file_key=key,
                    uploaded_by=user.id,
                    # A microsecond apart: they keep the order given.
                    created_at=now + timedelta(microseconds=index),
                )
                for index, key in enumerate(keys)
            ]
            # Inserted in key order: two reports racing for the same keys wait on them in one
            # order, so one gets the unique violation (422), never a deadlock.
            await self._photos.add_all(sorted(photos, key=lambda photo: photo.file_key))
        except IntegrityError as error:
            await self._session.rollback()
            constraint = violated_constraint(error)
            if constraint == ONE_PER_JOB:  # pragma: no cover - under the lock
                return await self.customer_view(user, job_id), False
            if constraint == IDEMPOTENCY_KEY_INDEX:
                # A report on another job took this key after the check above (the index held
                # this insert until it committed).
                raise IdempotencyKeyReusedError from None
            # Another dispute took one of the photo keys after the check above.
            raise InvalidDisputeInputError from None
        await self._jobs.disputed(job.job_id, user)
        public_code = await self._requests.public_code(job.request_id)
        await self._session.commit()
        logger.info(
            "dispute_reported",
            extra={
                "dispute_id": str(dispute.id),
                "job_id": str(job.job_id),
                "pro_id": str(job.pro_id),
                "reason_code": dispute.reason_code.value,
                "photos": len(photos),
            },
        )
        await push_job_disputed(
            queue,
            pro_user_id=job.pro_user_id,
            job_id=job.job_id,
            public_code=public_code,
            timeout_seconds=self._config.enqueue_timeout_seconds,
        )
        await self._queue_copies(dispute.id, [photo.id for photo in photos], queue)
        return await self.customer_view(user, job_id), True

    async def customer_view(self, user: UserAccount, job_id: uuid.UUID) -> CustomerDisputeView:
        """The customer's report on their job, if any, and whether they may report now."""
        job = await self._jobs.of_party(user.id, job_id)
        if job is None or job.customer_id != user.id:
            raise NotFoundError
        dispute = await self._disputes.of_job(job.job_id)
        out = None
        if dispute is not None:
            photos, pending = self._signer.for_owner(await self._photos.of_dispute(dispute.id))
            out = CustomerDisputeOut(
                id=dispute.id,
                reason_code=dispute.reason_code,
                description=dispute.description,
                status=dispute.status,
                resolution=dispute.resolution,
                created_at=dispute.created_at,
                resolved_at=dispute.resolved_at,
                photos=photos,
                photos_pending=pending,
            )
        return CustomerDisputeView(
            dispute=out,
            can_report=dispute is None and self._disputable(job),
            report_by=self._report_by(job),
        )

    async def pro_view(self, user: UserAccount, job_id: uuid.UUID) -> ProDisputeView:
        """The report on the pro's job, if any: safe copies only, and their own reply."""
        job = await self._own_pro_job(user, job_id)
        dispute = await self._disputes.of_job(job.job_id)
        if dispute is None:
            return ProDisputeView(dispute=None, can_reply=False)
        photos, pending = self._signer.for_other_side(await self._photos.of_dispute(dispute.id))
        return ProDisputeView(
            dispute=ProDisputeOut(
                id=dispute.id,
                reason_code=dispute.reason_code,
                description=dispute.description,
                status=dispute.status,
                resolution=dispute.resolution,
                created_at=dispute.created_at,
                resolved_at=dispute.resolved_at,
                photos=photos,
                photos_pending=pending,
                reply=dispute.pro_reply,
                replied_at=dispute.pro_replied_at,
            ),
            can_reply=_can_reply(dispute),
        )

    async def reply(
        self, user: UserAccount, job_id: uuid.UUID, data: DisputeReplyIn
    ) -> ProDisputeView:
        """The pro's one answer to the report on their job, for the admin. The same text again
        is a replay (the view, unchanged); a different one is 409 `already_replied`."""
        job = await self._own_pro_job(user, job_id)
        message = _clean(data.message)
        dispute = await self._disputes.of_job(job.job_id)
        if dispute is None or dispute.status is not DisputeStatus.OPEN:
            raise NoDisputeError
        if dispute.pro_reply is None and await self._disputes.set_pro_reply(
            dispute.id, message, self._clock()
        ):
            await self._session.commit()
            logger.info(
                "dispute_replied", extra={"dispute_id": str(dispute.id), "job_id": str(job_id)}
            )
            return await self.pro_view(user, job_id)
        # A reply is there (this one's earlier send, or another one), or the dispute was
        # resolved since it was read.
        await self._session.rollback()
        stored = await self._disputes.of_job(job.job_id)
        if stored is None or stored.status is not DisputeStatus.OPEN:
            raise NoDisputeError
        if stored.pro_reply != message:
            raise AlreadyRepliedError
        return await self.pro_view(user, job_id)

    # Helpers

    def _check_photo_key_shapes(self, user: UserAccount, keys: list[str]) -> None:
        """The caller's own dispute_photo uploads, each once, not too many."""
        if len(keys) > self._config.photo_max or len(set(keys)) != len(keys):
            raise InvalidDisputeInputError
        if any(owned_upload(key, user.id, UploadPurpose.DISPUTE_PHOTO) is None for key in keys):
            raise InvalidDisputeInputError

    def _check_photo_key_ages(self, keys: list[str]) -> None:
        """Each upload issued at most photo_attach_max_age ago (the orphan sweep's window).
        Checked for a new report only: a retry of one already made is answered first."""
        oldest = self._clock() - self._config.photo_attach_max_age
        if any((issued := upload_issued_at(key)) is None or issued < oldest for key in keys):
            raise InvalidDisputeInputError

    def _report_by(self, job: JobDisputeFacts) -> datetime | None:
        if job.status is not JobStatus.COMPLETED or job.completed_at is None:
            return None
        return job.completed_at + self._config.window

    def _disputable(self, job: JobDisputeFacts) -> bool:
        report_by = self._report_by(job)
        return report_by is not None and self._clock() < report_by

    async def _own_pro_job(self, user: UserAccount, job_id: uuid.UUID) -> JobDisputeFacts:
        """The caller's own job as its pro; 404 for any other job and an unknown one."""
        job = await self._jobs.of_party(user.id, job_id)
        if job is None or job.pro_user_id != user.id:
            raise NotFoundError
        return job

    async def _queue_copies(
        self, dispute_id: uuid.UUID, photo_ids: list[uuid.UUID], queue: JobQueue
    ) -> None:
        """Queues the photos' safe copies, after the commit; a failure is logged, never raised
        (the photos stay pending and are shown to the customer as their originals)."""
        try:
            await enqueue_dispute_photo_sanitize(
                queue, dispute_id, photo_ids, self._config.enqueue_timeout_seconds
            )
        except (RedisError, OSError):  # TimeoutError is an OSError
            logger.error(
                "dispute_photo_sanitize_enqueue_failed", extra={"dispute_id": str(dispute_id)}
            )


def _fingerprint(data: DisputeIn) -> str:
    """The body's fingerprint (app.idempotency). Text with no UTF-8 form is the validation
    error a report without a key answers too, raised before the key is looked up."""
    try:
        return body_fingerprint(data)
    except UnicodeEncodeError:
        raise InvalidDisputeInputError from None


def _clean(text: str) -> str:
    """The text as stored: contact details masked, trimmed; 422 when nothing is left (only
    invisible characters) or, in theory, masks run it past the limit."""
    cleaned = redact_contacts(text).text.strip()
    if not cleaned or len(cleaned) > TEXT_MAX_LENGTH:
        raise InvalidDisputeInputError
    return cleaned


def _can_reply(dispute: Dispute) -> bool:
    return dispute.status is DisputeStatus.OPEN and dispute.pro_reply is None
