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

The arrival code is never logged, never in an error, never in a pro response. Logs carry ids.
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

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import NotFoundError
from app.modules.categories.service import CategoryService
from app.modules.jobs.errors import (
    ArrivalCodeInvalidError,
    ArrivalCodeLockedError,
    CheckInRequiredError,
    NotOnTheWayError,
)
from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.jobs.repository import JobRepository
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
from app.modules.pros.service import ProService
from app.modules.quotes.schemas import QuotePro
from app.modules.quotes.service import QuoteReader
from app.modules.requests.errors import InvalidRequestError
from app.modules.requests.service import CustomerRequestReader, ProRequestReader
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)

ETA_UPDATED: Final = "eta_updated"
CHECKED_IN: Final = "checked_in"
ACTIVE: Final = frozenset({JobStatus.SCHEDULED, JobStatus.ON_THE_WAY, JobStatus.IN_PROGRESS})
# The pro no longer goes there: the address is withheld again.
_ADDRESS_WITHHELD: Final = frozenset({JobStatus.CANCELLED, JobStatus.REFUNDED})
# jobs_events.lat/lng are Numeric(9, 6).
_COORDINATE: Final = Decimal("0.000001")


@dataclass(frozen=True)
class JobExecutionConfig:
    max_attempts: int
    list_default_limit: int
    list_max_limit: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "JobExecutionConfig":
        return cls(
            max_attempts=settings.arrival_code_max_attempts,
            list_default_limit=settings.request_list_default_limit,
            list_max_limit=settings.request_list_max_limit,
        )


def new_arrival_code() -> str:
    """Four digits, 0000-9999, from the operating system's CSPRNG."""
    return f"{secrets.randbelow(10_000):04d}"


class JobExecutionService:
    def __init__(self, session: AsyncSession, config: JobExecutionConfig) -> None:
        self._session = session
        self._config = config
        self._jobs = JobRepository(session)
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
            timeline=[
                JobTimelineEntry(type=event.type, status=event.to_status, at=event.created_at)
                for event in events
            ],
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

    async def on_the_way(self, user: UserAccount, job_id: uuid.UUID, eta_minutes: int) -> ProJob:
        job = await self._own_locked(user, job_id)
        eta_at = datetime.now(UTC) + timedelta(minutes=eta_minutes)
        if job.status is JobStatus.ON_THE_WAY:
            job.eta_at = eta_at
            await self._jobs.add_event(JobEvent(job_id=job.id, type=ETA_UPDATED, actor_id=user.id))
            event = "job_eta_updated"
        else:
            # 409 for anything but scheduled; the event is the state machine's.
            await self._machine.transition(job.id, JobStatus.ON_THE_WAY, user)
            job.eta_at = eta_at
            job.arrival_code = new_arrival_code()
            job.arrival_code_attempts = 0
            job.arrival_code_locked_at = None
            await self._session.flush()
            event = "job_on_the_way"
        await self._session.commit()
        logger.info(event, extra={"job_id": str(job.id), "pro_id": str(job.pro_id)})
        return await self.pro_job(user, job.id)

    async def check_in(
        self, user: UserAccount, job_id: uuid.UUID, arrival_code: str, lat: float, lng: float
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
            await self._session.commit()
            logger.info("job_checked_in", extra=ids)
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

    async def start(self, user: UserAccount, job_id: uuid.UUID) -> ProJob:
        job = await self._own_locked(user, job_id)
        if job.status in (JobStatus.SCHEDULED, JobStatus.ON_THE_WAY) and job.checked_in_at is None:
            raise CheckInRequiredError
        # 409 for anything but on the way; the state machine sets started_at.
        await self._machine.transition(job.id, JobStatus.IN_PROGRESS, user)
        await self._session.commit()
        logger.info("job_started", extra={"job_id": str(job.id), "pro_id": str(job.pro_id)})
        return await self.pro_job(user, job.id)

    # Helpers

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
