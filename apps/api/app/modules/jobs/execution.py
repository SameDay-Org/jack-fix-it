"""Job execution, part 1 (D12.2, #63): the customer and the pro read their job, and the pro moves
it On my way -> Arrived (check-in) -> Working.

Reads:
- The customer reads the job of their own request (else 404, the same body as the request
  itself; 404 too while it has no job). The arrival code shows only while the job is on the way
  and the pro has not checked in. The timeline has event types and times: no actor, no location.
  The amounts are what the customer paid, never the payout or the fee.
- The pro reads their own jobs (another pro's, or a pro without a profile: 404). They see the
  request as the opportunity showed it (category, the description with contacts masked) plus the
  whole address, which they need to get there, and the customer's first name only. Never the
  arrival code or a contact: contacts typed into the address are masked too, the address
  kept. The address is withheld again once the job is cancelled or refunded. The list is newest
  scheduled start first (the accepted quote's proposed start, then the job id), with an
  `active` filter (scheduled, on the way, working).

Actions, each on the job's row lock (JobRepository.get_for_update), in one transaction the
service commits; every status change goes through JobStateMachine, which writes the job event:
- On my way (eta_minutes): scheduled -> on_the_way; eta_at = now + eta_minutes; a new arrival
  code (4 digits from a CSPRNG) with its attempt counter reset. Again while on the way: only the
  ETA changes, with an `eta_updated` event, and the code stays. Any other status: 409.
- Check-in (arrival_code, lat, lng) on a job on the way: the right code records `checked_in_at`
  and a `checked_in` event with the location, and clears the code. Once checked in, a check-in
  answers 200 again without looking at the code. A wrong code counts one try under the lock:
  422 `arrival_code_invalid` with the tries left (header), and the try that reaches
  ARRIVAL_CODE_MAX_ATTEMPTS locks the code: 423 `arrival_code_locked`, then and for every later
  try, and an ERROR log for the BDC. The customer's view does not change. Codes are compared in
  constant time. The location is recorded only: no distance check (Cesar: the location is only
  the check-in point).
- Start: on_the_way -> in_progress after a check-in (the state machine sets started_at); 409
  `check_in_required` without one. The table's direct scheduled -> in_progress edge is not
  offered here: a scheduled job answers check_in_required too.

Job photos and Job's done (part 2, #298), also on the job's row lock:
- Add photos (kind, upload_keys): the caller's own job_photo uploads only (else 422
  invalid_photo, nothing stored), issued at most JOB_PHOTO_ATTACH_MAX_AGE_MINUTES ago (else 422
  upload_expired: the pro uploads again). That window is at most half of the orphan sweep's
  minimum age (config.py), so the sweep never deletes a key this call accepted: the sweep
  reads the references of an upload at least ORPHAN_UPLOAD_MIN_AGE_HOURS old, and any
  attach of that key had committed half that time before (orphans.py). Before photos while on
  the way or working, after photos while working (else 409 job_photo_not_allowed). A key given
  twice, or one a job photo already holds: 409 duplicate_photo. More than
  JOB_PHOTO_MAX_PER_KIND of a kind whose safe copy has not failed, or more than twice that
  counting the failed ones: 409 job_photo_limit (checked before the keys are looked up). So a
  pro replaces failed photos, never without bound: a job with twice the cap of a kind, none of
  its after photos ready, is the BDC's to resolve. They keep the order given. After the commit
  their privacy-safe copies are queued, one run per batch (photos.py); a failed enqueue never
  fails the call (the photos stay pending).
- Job's done: in_progress -> completed only with at least one after photo whose safe copy is
  ready, the copy that proves to the customer a real image was taken. With none ready: 409
  after_photos_processing while one is still being made (the app waits and tries again; each
  try queues the pending ones' copies again, so a lost enqueue or a run that ended unsettled
  recovers, and a run still going for them makes it a no-op: photos.py; the answer and the
  batch come from one read, so a copy settled just after it still answers this 409 and the
  next try decides), else
  409 after_photos_required (none, or all failed: the pro adds another). Nothing changes on a
  409. The state machine sets completed_at, which opens the customer's confirmation window
  (#66, #67). Again once completed: 200, unchanged, no second event.
- Both views list the photos by kind, oldest first, signed for DOWNLOAD_URL_TTL_SECONDS: the
  customer only their safe copies (photos.py says why).

Pushes (#65): once On my way, the check-in or the start commits, the customer hears about it,
once per job (notifications.events: the job's id and the step name the event); Job's done too,
once its move to completed commits; the pro hears once the job is confirmed (#66, #67). An ETA
update, a repeated check-in or Job's done, and a
refused action push nothing. A push that cannot be queued is logged with ids and never fails
the action. No push carries the arrival code or the ETA.

Confirmation (#66), the customer's, on the job's row lock: completed -> confirmed through the
state machine (it sets confirmed_at; the event's actor is the customer), then the pro's push.
Again once confirmed: 200, unchanged, no second event or push. Any other status: 409
job_not_completed. While completed, the customer's view carries confirm_by, when the system
confirms the job on its own if neither the customer confirms nor a problem is open
(completed_at + JOB_AUTO_CONFIRM_AFTER_HOURS; the cron is #67, confirmation.py). The customer
and the cron take the same lock and read the job again under it, so racing they make one
transition, one event and one push.

The arrival code is never logged, never in an error, never in a pro response. Logs carry ids:
never an upload key.
"""

import base64
import binascii
import hmac
import logging
import secrets
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_EVEN, Decimal
from typing import Final

from redis.exceptions import RedisError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import NotFoundError
from app.integrations.storage import StorageProvider
from app.modules.categories.service import CategoryService
from app.modules.jobs.confirmation import confirm_by
from app.modules.jobs.errors import (
    AfterPhotosProcessingError,
    AfterPhotosRequiredError,
    ArrivalCodeInvalidError,
    ArrivalCodeLockedError,
    CheckInRequiredError,
    DuplicateJobPhotoError,
    InvalidJobPhotoError,
    JobNotCompletedError,
    JobPhotoLimitError,
    JobPhotoNotAllowedError,
    JobPhotoUploadExpiredError,
    NotOnTheWayError,
)
from app.modules.jobs.models import Job, JobEvent, JobPhoto, JobPhotoKind, JobStatus
from app.modules.jobs.photos import JobPhotoSigner, enqueue_photo_sanitize
from app.modules.jobs.repository import JobPhotoRepository, JobRepository
from app.modules.jobs.schemas import (
    CustomerJob,
    JobAddress,
    JobCategory,
    JobTimelineEntry,
    ProJob,
    ProJobPage,
)
from app.modules.jobs.service import JobStateMachine
from app.modules.jobs.transitions import CUSTOMER_STATUS
from app.modules.media.safe_status import MediaSafeStatus
from app.modules.notifications.events import (
    push_job_checked_in,
    push_job_confirmed,
    push_job_done,
    push_job_on_the_way,
    push_job_started,
)
from app.modules.pros.service import ProService
from app.modules.quotes.schemas import QuotePro
from app.modules.quotes.service import QuoteReader
from app.modules.requests.errors import InvalidRequestError
from app.modules.requests.service import CustomerRequestReader, ProRequestReader
from app.modules.uploads.keys import owned_upload, upload_issued_at
from app.modules.uploads.schemas import UploadPurpose
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount
from app.queue import JobQueue

logger = logging.getLogger(__name__)

ETA_UPDATED: Final = "eta_updated"
CHECKED_IN: Final = "checked_in"
ACTIVE: Final = frozenset({JobStatus.SCHEDULED, JobStatus.ON_THE_WAY, JobStatus.IN_PROGRESS})
# The pro no longer goes there: the address is withheld again.
_ADDRESS_WITHHELD: Final = frozenset({JobStatus.CANCELLED, JobStatus.REFUNDED})
# When the pro may add photos of each kind (#298).
_PHOTO_STATUSES: Final = {
    JobPhotoKind.BEFORE: frozenset({JobStatus.ON_THE_WAY, JobStatus.IN_PROGRESS}),
    JobPhotoKind.AFTER: frozenset({JobStatus.IN_PROGRESS}),
}
# Every photo row of a kind, failed copies included, counts against this many times
# JOB_PHOTO_MAX_PER_KIND: a failed copy frees its slot for a replacement, a bounded number of
# times.
_ROWS_PER_SLOT: Final = 2
# jobs_events.lat/lng are Numeric(9, 6).
_COORDINATE: Final = Decimal("0.000001")


@dataclass(frozen=True)
class JobExecutionConfig:
    max_attempts: int
    list_default_limit: int
    list_max_limit: int
    photo_max_per_kind: int
    photo_attach_max_age: timedelta
    photo_url_ttl_seconds: int
    enqueue_timeout_seconds: float
    auto_confirm_after: timedelta

    @classmethod
    def from_settings(cls, settings: Settings) -> "JobExecutionConfig":
        return cls(
            max_attempts=settings.arrival_code_max_attempts,
            list_default_limit=settings.request_list_default_limit,
            list_max_limit=settings.request_list_max_limit,
            photo_max_per_kind=settings.job_photo_max_per_kind,
            photo_attach_max_age=timedelta(minutes=settings.job_photo_attach_max_age_minutes),
            photo_url_ttl_seconds=settings.download_url_ttl_seconds,
            enqueue_timeout_seconds=settings.job_enqueue_timeout_seconds,
            auto_confirm_after=timedelta(hours=settings.job_auto_confirm_after_hours),
        )


def new_arrival_code() -> str:
    """Four digits, 0000-9999, from the operating system's CSPRNG."""
    return f"{secrets.randbelow(10_000):04d}"


class JobExecutionService:
    def __init__(
        self, session: AsyncSession, config: JobExecutionConfig, storage: StorageProvider
    ) -> None:
        self._session = session
        self._config = config
        self._jobs = JobRepository(session)
        self._photos = JobPhotoRepository(session)
        self._signer = JobPhotoSigner(storage, config.photo_url_ttl_seconds)
        self._pros = ProService(session)
        self._machine = JobStateMachine(session, self._pros)
        self._customer_requests = CustomerRequestReader(session)
        self._requests = ProRequestReader(session)
        self._quotes = QuoteReader(session)
        self._users = UserService(session)
        self._categories = CategoryService(session)

    # Reads

    async def customer_job(self, user: UserAccount, request_id: uuid.UUID) -> CustomerJob:
        await self._customer_requests.own_status(user, request_id)  # 404 for anyone else's
        job = await self._jobs.get_of_request(request_id)
        if job is None or job.customer_id != user.id:
            raise NotFoundError
        starts = await self._quotes.proposed_starts([job.quote_id])
        card = (await self._pros.cards([job.pro_id])).get(job.pro_id)
        if card is None:  # pragma: no cover - jobs.pro_id is a foreign key
            raise NotFoundError
        events = await self._jobs.events_of(job.id)
        photos = await self._photos.of_jobs([job.id])
        shows_code = job.status is JobStatus.ON_THE_WAY and job.checked_in_at is None
        return CustomerJob(
            id=job.id,
            status=job.status,
            customer_status=CUSTOMER_STATUS[job.status],
            scheduled_start_at=starts[job.quote_id],
            pro=QuotePro(
                id=card.pro_id,
                name=card.name,
                rating_avg=None if card.rating_avg is None else format(card.rating_avg, ".2f"),
                jobs_count=card.jobs_count,
                years_of_experience=card.years_of_experience,
                verified=card.verified,
            ),
            eta_at=job.eta_at,
            arrival_code=job.arrival_code if shows_code else None,
            confirm_by=confirm_by(job, self._config.auto_confirm_after),
            timeline=[
                JobTimelineEntry(type=event.type, status=event.to_status, at=event.created_at)
                for event in events
            ],
            photos=self._signer.for_customer(photos),
            amount_cents=job.customer_price_cents,
            tax_cents=job.tax_cents,
            customer_total_cents=job.customer_price_cents + job.tax_cents,
        )

    async def pro_jobs(
        self, user: UserAccount, *, active: bool, limit: int | None, cursor: str | None
    ) -> ProJobPage:
        """Newest scheduled start first (the accepted quote's proposed start, then the job id,
        which the cursor carries too). `limit` above the maximum is capped, not refused."""
        size = min(limit or self._config.list_default_limit, self._config.list_max_limit)
        before = _decode_cursor(cursor) if cursor else None
        pro_id = await self._pros.get_profile_id_for_user(user.id)
        if pro_id is None:  # no profile: no job was ever theirs
            return ProJobPage(items=[], next_cursor=None)
        rows = await self._jobs.page_for_pro(
            pro_id, ACTIVE if active else None, QuoteReader.starts(), size + 1, before
        )
        page, more = rows[:size], len(rows) > size
        return ProJobPage(
            items=await self._pro_views([job for job, _ in page]),
            next_cursor=_encode_cursor(*page[-1]) if more and page else None,
        )

    async def pro_job(self, user: UserAccount, job_id: uuid.UUID) -> ProJob:
        pro_id = await self._pros.get_profile_id_for_user(user.id)
        job = await self._jobs.get(job_id)
        if job is None or pro_id is None or job.pro_id != pro_id:
            raise NotFoundError
        [view] = await self._pro_views([job])
        return view

    # Actions

    async def on_the_way(
        self, user: UserAccount, job_id: uuid.UUID, eta_minutes: int, queue: JobQueue
    ) -> ProJob:
        job = await self._own_locked(user, job_id)
        eta_at = datetime.now(UTC) + timedelta(minutes=eta_minutes)
        if job.status is JobStatus.ON_THE_WAY:
            job.eta_at = eta_at
            await self._jobs.add_event(JobEvent(job_id=job.id, type=ETA_UPDATED, actor_id=user.id))
            event = "job_eta_updated"
            public_code = None  # an ETA update pushes nothing (#65)
        else:
            # 409 for anything but scheduled; the event is the state machine's.
            await self._machine.transition(job.id, JobStatus.ON_THE_WAY, user)
            job.eta_at = eta_at
            job.arrival_code = new_arrival_code()
            job.arrival_code_attempts = 0
            job.arrival_code_locked_at = None
            await self._session.flush()
            event = "job_on_the_way"
            public_code = await self._customer_requests.public_code(job.request_id)
        await self._session.commit()
        logger.info(event, extra={"job_id": str(job.id), "pro_id": str(job.pro_id)})
        if public_code is not None:
            await push_job_on_the_way(
                queue,
                customer_id=job.customer_id,
                job_id=job.id,
                request_id=job.request_id,
                public_code=public_code,
                timeout_seconds=self._config.enqueue_timeout_seconds,
            )
        return await self.pro_job(user, job.id)

    async def check_in(
        self,
        user: UserAccount,
        job_id: uuid.UUID,
        arrival_code: str,
        lat: float,
        lng: float,
        queue: JobQueue,
    ) -> ProJob:
        job = await self._own_locked(user, job_id)
        ids = {"job_id": str(job.id), "pro_id": str(job.pro_id)}
        if job.checked_in_at is not None:
            await self._session.commit()  # nothing changed: ends the transaction and its lock
            return await self.pro_job(user, job.id)
        if job.status is not JobStatus.ON_THE_WAY:
            raise NotOnTheWayError
        if job.arrival_code_locked_at is not None:
            raise ArrivalCodeLockedError
        if _same_code(job.arrival_code, arrival_code):
            job.checked_in_at = datetime.now(UTC)
            job.arrival_code = None
            await self._jobs.add_event(
                JobEvent(
                    job_id=job.id,
                    type=CHECKED_IN,
                    actor_id=user.id,
                    lat=_coordinate(lat),
                    lng=_coordinate(lng),
                )
            )
            public_code = await self._customer_requests.public_code(job.request_id)
            await self._session.commit()
            logger.info("job_checked_in", extra=ids)
            await push_job_checked_in(
                queue,
                customer_id=job.customer_id,
                job_id=job.id,
                request_id=job.request_id,
                public_code=public_code,
                timeout_seconds=self._config.enqueue_timeout_seconds,
            )
            return await self.pro_job(user, job.id)
        # A wrong code: counted under the row lock, so concurrent tries cannot pass the limit.
        job.arrival_code_attempts += 1
        remaining = self._config.max_attempts - job.arrival_code_attempts
        if remaining <= 0:
            job.arrival_code_locked_at = datetime.now(UTC)
        await self._session.flush()
        await self._session.commit()
        if remaining <= 0:
            # For the BDC: the customer's view shows nothing new; support resolves it.
            logger.error("arrival_code_locked", extra={"job_id": str(job.id)})
            raise ArrivalCodeLockedError
        logger.info("arrival_code_rejected", extra={**ids, "attempts_remaining": remaining})
        raise ArrivalCodeInvalidError(remaining)

    async def start(self, user: UserAccount, job_id: uuid.UUID, queue: JobQueue) -> ProJob:
        job = await self._own_locked(user, job_id)
        if job.status in (JobStatus.SCHEDULED, JobStatus.ON_THE_WAY) and job.checked_in_at is None:
            raise CheckInRequiredError
        # 409 for anything but on the way; the state machine sets started_at.
        await self._machine.transition(job.id, JobStatus.IN_PROGRESS, user)
        public_code = await self._customer_requests.public_code(job.request_id)
        await self._session.commit()
        logger.info("job_started", extra={"job_id": str(job.id), "pro_id": str(job.pro_id)})
        await push_job_started(
            queue,
            customer_id=job.customer_id,
            job_id=job.id,
            request_id=job.request_id,
            public_code=public_code,
            timeout_seconds=self._config.enqueue_timeout_seconds,
        )
        return await self.pro_job(user, job.id)

    async def add_photos(
        self,
        user: UserAccount,
        job_id: uuid.UUID,
        kind: JobPhotoKind,
        keys: Sequence[str],
        queue: JobQueue,
    ) -> ProJob:
        job = await self._own_locked(user, job_id)
        if job.status not in _PHOTO_STATUSES[kind]:
            raise JobPhotoNotAllowedError
        if any(owned_upload(key, user.id, UploadPurpose.JOB_PHOTO) is None for key in keys):
            raise InvalidJobPhotoError
        oldest = datetime.now(UTC) - self._config.photo_attach_max_age
        if any((issued_at := upload_issued_at(key)) is None or issued_at < oldest for key in keys):
            raise JobPhotoUploadExpiredError
        # The cap before any query on the keys: a huge body never reaches the database.
        counts = await self._photos.count_by_status(job.id, kind)
        cap = self._config.photo_max_per_kind
        live = counts[MediaSafeStatus.PENDING] + counts[MediaSafeStatus.READY]
        if live + len(keys) > cap or sum(counts.values()) + len(keys) > _ROWS_PER_SLOT * cap:
            raise JobPhotoLimitError
        if len(set(keys)) != len(keys) or await self._photos.held_keys(keys):
            raise DuplicateJobPhotoError
        # One transaction shares now(): a microsecond apart, they keep the order given.
        now = datetime.now(UTC)
        photos = [
            JobPhoto(
                job_id=job.id,
                kind=kind,
                file_key=key,
                uploaded_by=user.id,
                created_at=now + timedelta(microseconds=index),
            )
            for index, key in enumerate(keys)
        ]
        try:
            await self._photos.add_all(photos)
        except IntegrityError:
            # Another job's photo took one of the keys after the check above.
            await self._session.rollback()
            raise DuplicateJobPhotoError from None
        await self._session.commit()
        logger.info(
            "job_photos_added",
            extra={
                "job_id": str(job.id),
                "pro_id": str(job.pro_id),
                "kind": kind.value,
                "count": len(photos),
            },
        )
        await self._queue_copies(job, [photo.id for photo in photos], queue)
        return await self.pro_job(user, job.id)

    async def complete(self, user: UserAccount, job_id: uuid.UUID, queue: JobQueue) -> ProJob:
        job = await self._own_locked(user, job_id)
        if job.status is JobStatus.COMPLETED:
            await self._session.commit()  # nothing changed: ends the transaction and its lock
            return await self.pro_job(user, job.id)
        if job.status is JobStatus.IN_PROGRESS:
            # Under the job's lock a photo added meanwhile waits, but the worker settles copies
            # without it: the decision and the batch come from one read, so a copy settled
            # after it answers 409 processing and the pro's next try sees it (#298 R2-B1).
            after = await self._photos.statuses(job.id, JobPhotoKind.AFTER)
            if all(status is not MediaSafeStatus.READY for _, status in after):
                pending = [
                    photo_id for photo_id, status in after if status is MediaSafeStatus.PENDING
                ]
                if not pending:
                    raise AfterPhotosRequiredError
                await self._session.commit()  # nothing changed: ends the transaction and its lock
                await self._queue_copies(job, pending, queue)
                raise AfterPhotosProcessingError
        # 409 for anything but working; the state machine sets completed_at.
        await self._machine.transition(job.id, JobStatus.COMPLETED, user)
        public_code = await self._customer_requests.public_code(job.request_id)
        await self._session.commit()
        logger.info("job_completed", extra={"job_id": str(job.id), "pro_id": str(job.pro_id)})
        await push_job_done(
            queue,
            customer_id=job.customer_id,
            job_id=job.id,
            request_id=job.request_id,
            public_code=public_code,
            timeout_seconds=self._config.enqueue_timeout_seconds,
        )
        return await self.pro_job(user, job.id)

    async def confirm(
        self, user: UserAccount, request_id: uuid.UUID, queue: JobQueue
    ) -> CustomerJob:
        job = await self._customer_locked(user, request_id)
        if job.status is JobStatus.CONFIRMED:
            await self._session.commit()  # nothing changed: ends the transaction and its lock
            return await self.customer_job(user, request_id)
        if job.status is not JobStatus.COMPLETED:
            raise JobNotCompletedError
        # The state machine sets confirmed_at and writes the event, the customer as its actor.
        await self._machine.transition(job.id, JobStatus.CONFIRMED, user)
        public_code = await self._customer_requests.public_code(job.request_id)
        pro_user_id = await self._pros.user_id_of(job.pro_id)
        await self._session.commit()
        logger.info("job_confirmed", extra={"job_id": str(job.id), "pro_id": str(job.pro_id)})
        if pro_user_id is not None:  # pragma: no branch - jobs.pro_id is a foreign key
            await push_job_confirmed(
                queue,
                pro_user_id=pro_user_id,
                job_id=job.id,
                public_code=public_code,
                timeout_seconds=self._config.enqueue_timeout_seconds,
            )
        return await self.customer_job(user, request_id)

    # Helpers

    async def _queue_copies(self, job: Job, photo_ids: list[uuid.UUID], queue: JobQueue) -> None:
        """Queues the photos' safe copies, after the commit; a failure is logged, never raised
        (the photos stay pending, and Job's done queues them again)."""
        try:
            await enqueue_photo_sanitize(
                queue, job.id, photo_ids, self._config.enqueue_timeout_seconds
            )
        except (RedisError, OSError):  # TimeoutError is an OSError
            logger.error(
                "job_photo_sanitize_enqueue_failed",
                extra={"job_id": str(job.id), "pro_id": str(job.pro_id)},
            )

    async def _customer_locked(self, user: UserAccount, request_id: uuid.UUID) -> Job:
        """The job of the caller's own request, locked until the transaction ends; 404 for
        anyone else's request, and while it has no job (as customer_job)."""
        await self._customer_requests.own_status(user, request_id)
        job = await self._jobs.get_of_request_for_update(request_id)
        if job is None or job.customer_id != user.id:
            raise NotFoundError
        return job

    async def _own_locked(self, user: UserAccount, job_id: uuid.UUID) -> Job:
        """The caller's job, locked until the transaction ends; 404 for anyone else's."""
        pro_id = await self._pros.get_profile_id_for_user(user.id)
        job = await self._jobs.get_for_update(job_id)
        if job is None or pro_id is None or job.pro_id != pro_id:
            raise NotFoundError
        return job

    async def _pro_views(self, jobs: Sequence[Job]) -> list[ProJob]:
        """The jobs as their pro sees them, in order. One query each for the quotes' starts,
        the requests (with their addresses, names and contacts for masking) and categories."""
        starts = await self._quotes.proposed_starts([job.quote_id for job in jobs])
        requests = await self._requests.job_views([job.request_id for job in jobs])
        names = await self._users.first_names([job.customer_id for job in jobs])
        photos: dict[uuid.UUID, list[JobPhoto]] = {job.id: [] for job in jobs}
        for photo in await self._photos.of_jobs(list(photos)):
            photos[photo.job_id].append(photo)
        category_ids = {
            request.view.category_id
            for request in requests.values()
            if request.view.category_id is not None
        }
        categories = {
            summary.id: JobCategory(id=summary.id, slug=summary.slug, names=summary.names)
            for summary in await self._categories.summaries(category_ids)
        }
        items: list[ProJob] = []
        for job in jobs:
            request = requests[job.request_id]
            address = request.address
            category_id = request.view.category_id
            items.append(
                ProJob(
                    id=job.id,
                    status=job.status,
                    scheduled_start_at=starts[job.quote_id],
                    category=categories.get(category_id) if category_id else None,
                    description=request.view.description,
                    address=None
                    if job.status in _ADDRESS_WITHHELD
                    else JobAddress(
                        line1=address.line1,
                        line2=address.line2,
                        city=address.city,
                        state=address.state,
                        zip_code=address.zip_code,
                    ),
                    customer_first_name=names.get(job.customer_id),
                    eta_at=job.eta_at,
                    checked_in_at=job.checked_in_at,
                    arrival_code_locked=job.arrival_code_locked_at is not None,
                    started_at=job.started_at,
                    completed_at=job.completed_at,
                    photos=self._signer.for_pro(photos[job.id]),
                    pro_payout_cents=job.pro_payout_cents,
                )
            )
        return items


def _same_code(stored: str | None, given: str) -> bool:
    """Constant-time comparison; no stored code never matches."""
    if stored is None:
        return False
    return hmac.compare_digest(stored.encode(), given.encode())


def _coordinate(value: float) -> Decimal:
    return Decimal(repr(value)).quantize(_COORDINATE, rounding=ROUND_HALF_EVEN)


def _encode_cursor(job: Job, scheduled_start: datetime) -> str:
    raw = f"{scheduled_start.isoformat()}|{job.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        scheduled_start, job_id = raw.split("|")
        decoded = datetime.fromisoformat(scheduled_start)
        if decoded.tzinfo is None:
            raise ValueError("naive timestamp")
        return decoded.astimezone(UTC), uuid.UUID(job_id)
    except (binascii.Error, UnicodeDecodeError, ValueError, OverflowError):
        raise InvalidRequestError from None
