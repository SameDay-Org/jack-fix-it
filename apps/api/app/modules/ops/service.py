"""The BDC's operations queue (D16.2, #81): staff (agent or admin) list the requests by bucket,
read the bucket counts, open a request's card and take or release a request.

- Buckets are computed by the requests module's query from the job, the pending quotes, the
  open support tickets and the settings (first-contact time, quote waiting time, business
  time zone): one bucket per request, by precedence. `all` lists every request.
- The list and the summary carry no contact detail: first name and last initial, a ZIP.
- The card carries the customer's name, phone, email and address, because the BDC calls
  them. Every card read writes an audit_log row and commits it before answering. Media are
  the privacy-safe copies only.
- Claim: the request row is locked; an unassigned request goes to the caller, the holder's
  own claim again changes nothing, anyone else's is a 409. Release: by the holder, or by an
  admin for anyone; releasing an unassigned request changes nothing. Each change writes one
  audit_log row in the same transaction: a failed audit write changes nothing. Claiming is not
  the first contact: first_contact_at is not touched here.

Logs carry ids, statuses, buckets and counts: never a name, a contact, an address or text.
"""

import base64
import binascii
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import ForbiddenError
from app.integrations.storage import StorageProvider
from app.modules.addresses.service import AddressService
from app.modules.audit.service import AuditService
from app.modules.audit.types import (
    ActorNotStaffError,
    AuditAction,
    AuditEntity,
    AuditEntityType,
    ReaderNotStaffError,
)
from app.modules.cancellations.service import pro_cancelled_job_ids
from app.modules.categories.schemas import CategorySummary
from app.modules.categories.service import CategoryService
from app.modules.dispatch.opportunities import sign_safe_media
from app.modules.jobs.service import JobStaffReader, JobStatus, StaffJob
from app.modules.jobs.transitions import CUSTOMER_STATUS
from app.modules.ops.actions import OpsRecords
from app.modules.ops.errors import (
    InvalidQueueQueryError,
    QueueRequestNotFoundError,
    RequestHeldError,
)
from app.modules.ops.schemas import (
    AssignedFilter,
    BucketFilter,
    CardCustomer,
    CardJob,
    CardJobEvent,
    CardMedia,
    CardQuote,
    ClaimOut,
    QueueAgent,
    QueueItem,
    QueuePage,
    QueueSummary,
    RequestCard,
)
from app.modules.pros.service import ProService
from app.modules.quotes.service import QuoteReader
from app.modules.requests.customer_status import REQUEST_CUSTOMER_STATUS
from app.modules.requests.queue import (
    After,
    LockedRequest,
    QueueBucket,
    QueuedRequest,
    QueueFilters,
    QueueRules,
    QueueSources,
    RequestQueueReader,
    RequestStatus,
)
from app.modules.requests.service import ProRequestReader
from app.modules.service_areas.schemas import zip5
from app.modules.support.service import SupportTicketService
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount, UserRole

logger = logging.getLogger(__name__)

# A job in one of these still has its visit ahead or under way: it can be "scheduled today".
_VISIT_AHEAD = (JobStatus.SCHEDULED, JobStatus.ON_THE_WAY, JobStatus.IN_PROGRESS)


@dataclass(frozen=True)
class OpsConfig:
    list_default_limit: int
    list_max_limit: int
    first_contact_sla_minutes: int
    quote_waiting_minutes: int
    time_zone: str
    url_ttl_seconds: int
    # How long a request whose pro cancelled its job stays under problems (#69).
    pro_cancel_attention_hours: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "OpsConfig":
        return cls(
            list_default_limit=settings.request_list_default_limit,
            list_max_limit=settings.request_list_max_limit,
            first_contact_sla_minutes=settings.ops_first_contact_sla_minutes,
            quote_waiting_minutes=settings.ops_quote_waiting_minutes,
            time_zone=settings.business_time_zone,
            url_ttl_seconds=settings.download_url_ttl_seconds,
            pro_cancel_attention_hours=settings.ops_pro_cancel_attention_hours,
        )


class OpsQueueService:
    def __init__(self, session: AsyncSession, storage: StorageProvider, config: OpsConfig) -> None:
        self._session = session
        self._storage = storage
        self._config = config
        self._requests = RequestQueueReader(session)
        self._media = ProRequestReader(session)
        self._jobs = JobStaffReader(session)
        self._quotes = QuoteReader(session)
        self._addresses = AddressService(session)
        self._categories = CategoryService(session)
        self._users = UserService(session)
        self._pros = ProService(session)
        self._audit = AuditService(session)
        self._records = OpsRecords(session)
        self._sla = timedelta(minutes=config.first_contact_sla_minutes)
        self._rules = QueueRules(
            first_contact_sla=self._sla,
            quote_waiting=timedelta(minutes=config.quote_waiting_minutes),
            time_zone=config.time_zone,
        )
        self._sources = QueueSources(
            jobs=JobStaffReader.queue_facts(),
            quote_starts=QuoteReader.starts(),
            pending_quotes=QuoteReader.pending_by_request(),
            open_ticket_jobs=SupportTicketService.open_job_ids(),
            pro_cancelled_jobs=pro_cancelled_job_ids(
                timedelta(hours=config.pro_cancel_attention_hours)
            ),
            zips=AddressService.zips(),
            problem_job_statuses=(JobStatus.DISPUTED,),
            active_job_statuses=_VISIT_AHEAD,
        )

    async def page(
        self,
        staff: UserAccount,
        *,
        bucket: BucketFilter,
        status: RequestStatus | None,
        category_id: uuid.UUID | None,
        zip_code: str | None,
        assigned: AssignedFilter,
        code: str | None,
        limit: int | None,
        cursor: str | None,
    ) -> QueuePage:
        """One page of the queue. A fixed number of queries, whatever the page holds."""
        after = _decode_cursor(cursor) if cursor else None
        size = min(limit or self._config.list_default_limit, self._config.list_max_limit)
        filters = QueueFilters(
            bucket=None if bucket is BucketFilter.ALL else QueueBucket(bucket.value),
            status=status,
            category_id=category_id,
            zip5=zip_code,
            assigned_to=staff.id if assigned is AssignedFilter.ME else None,
            unassigned=assigned is AssignedFilter.UNASSIGNED,
            code=code,
        )
        rows = await self._requests.page(
            self._sources, self._rules, filters, limit=size + 1, after=after
        )
        page, more = rows[:size], len(rows) > size
        return QueuePage(
            items=await self._items(page),
            next_cursor=_encode_cursor(page[-1]) if more and page else None,
        )

    async def summary(self) -> QueueSummary:
        """How many requests each bucket holds, in one query."""
        counts = await self._requests.counts(self._sources, self._rules)
        return QueueSummary(
            problems=counts.get(QueueBucket.PROBLEMS, 0),
            urgent=counts.get(QueueBucket.URGENT, 0),
            new=counts.get(QueueBucket.NEW, 0),
            waiting_customer=counts.get(QueueBucket.WAITING_CUSTOMER, 0),
            waiting_pro=counts.get(QueueBucket.WAITING_PRO, 0),
            quote_ready=counts.get(QueueBucket.QUOTE_READY, 0),
            scheduled_today=counts.get(QueueBucket.SCHEDULED_TODAY, 0),
            all=sum(counts.values()),
            first_contact_sla_minutes=self._config.first_contact_sla_minutes,
        )

    async def card(self, staff: UserAccount, request_id: uuid.UUID) -> RequestCard:
        """One request with the customer's contacts; the read is audited first. What the
        viewer may see of its follow-ups, and whether they may act on it, follow their account
        as this transaction reads it, never the role their token was issued with (#499 round
        1)."""
        viewer = await self._audit.current_staff(staff.id)
        if viewer is None:
            raise ForbiddenError
        row = await self._requests.one(request_id, self._sources, self._rules)
        if row is None:
            raise QueueRequestNotFoundError
        card = await self._card(row, viewer)
        holder = card.assigned_agent
        card.actions_allowed = (
            holder is None or holder.id == viewer.id or viewer.role is UserRole.ADMIN
        )
        # Committed before the answer: an audit write that fails answers 500, so no contact
        # is shown unaudited.
        try:
            await self._audit.record_read(
                staff.id,
                AuditAction.REQUEST_CARD_READ,
                AuditEntity(AuditEntityType.SERVICE_REQUEST, request_id),
                {
                    "status": row.status.value,
                    "media": len(card.media),
                    "notes": len(card.notes),
                    "followups": len(card.followups),
                },
            )
        except ReaderNotStaffError:
            await self._session.rollback()
            raise ForbiddenError from None
        await self._session.commit()
        logger.info(
            "request_card_read_by_staff",
            extra={
                "service_request_id": str(request_id),
                "staff_id": str(staff.id),
                "bucket": row.bucket.value,
            },
        )
        return card

    async def claim(self, staff: UserAccount, request_id: uuid.UUID) -> ClaimOut:
        """Gives an unassigned request to the caller, audited, and commits."""
        locked = await self._requests.lock(request_id)
        if locked is None:
            raise QueueRequestNotFoundError
        holder = locked.assigned_agent_id
        if holder == staff.id:
            await self._session.commit()  # a replay: nothing changed, only the row lock goes
            return await self._claim_out(request_id, holder)
        if holder is not None:
            raise RequestHeldError
        return await self._assign(staff, locked, AuditAction.REQUEST_CLAIM, staff.id)

    async def release(self, staff: UserAccount, request_id: uuid.UUID) -> ClaimOut:
        """Lets go of a request the caller holds (an admin: anyone's), audited, and commits."""
        locked = await self._requests.lock(request_id)
        if locked is None:
            raise QueueRequestNotFoundError
        holder = locked.assigned_agent_id
        if holder is None:
            await self._session.commit()  # nothing to release: only the row lock goes
            return await self._claim_out(request_id, None)
        if holder != staff.id and staff.role != UserRole.ADMIN:
            raise RequestHeldError
        return await self._assign(staff, locked, AuditAction.REQUEST_RELEASE, None)

    async def _assign(
        self,
        staff: UserAccount,
        locked: LockedRequest,
        action: AuditAction,
        agent_id: uuid.UUID | None,
    ) -> ClaimOut:
        before = locked.assigned_agent_id
        await self._requests.assign(locked, agent_id)
        try:
            # In the change's transaction: an audit write that fails rolls the change back.
            await self._audit.record_staff_action(
                staff.id,
                action,
                AuditEntity(AuditEntityType.SERVICE_REQUEST, locked.id),
                {"assigned_agent_id": None if before is None else str(before)},
                {"assigned_agent_id": None if agent_id is None else str(agent_id)},
            )
        except ActorNotStaffError:
            await self._session.rollback()
            raise ForbiddenError from None
        await self._session.commit()
        logger.info(
            "request_assignment_changed",
            extra={
                "service_request_id": str(locked.id),
                "staff_id": str(staff.id),
                "action": action.value,
            },
        )
        return await self._claim_out(locked.id, agent_id)

    async def _claim_out(self, request_id: uuid.UUID, holder: uuid.UUID | None) -> ClaimOut:
        agents = await self._agents({holder})
        return ClaimOut(id=request_id, assigned_agent=None if holder is None else agents[holder])

    async def _agents(self, agent_ids: set[uuid.UUID | None]) -> dict[uuid.UUID, QueueAgent]:
        ids = {agent_id for agent_id in agent_ids if agent_id is not None}
        names = await self._users.first_names(ids)
        return {agent_id: QueueAgent(id=agent_id, name=names.get(agent_id)) for agent_id in ids}

    async def _items(self, rows: list[QueuedRequest]) -> list[QueueItem]:
        requests = rows
        names = await self._users.public_names({request.customer_id for request in requests})
        agents = await self._agents({request.assigned_agent_id for request in requests})
        categories = {
            category.id: category
            for category in await self._categories.summaries(
                {r.category_id for r in requests if r.category_id is not None}
            )
        }
        media = await self._requests.media_counts([request.id for request in requests])
        return [
            self._item(
                row,
                customer_name=names.get(row.customer_id),
                category=categories.get(row.category_id) if row.category_id else None,
                agent=agents.get(row.assigned_agent_id) if row.assigned_agent_id else None,
                media_count=media.get(row.id, 0),
            )
            for row in rows
        ]

    def _item(
        self,
        row: QueuedRequest,
        *,
        customer_name: str | None,
        category: CategorySummary | None,
        agent: QueueAgent | None,
        media_count: int,
    ) -> QueueItem:
        request = row
        return QueueItem(
            id=request.id,
            public_code=request.public_code,
            customer_name=customer_name,
            category=category,
            zip_code=zip5(row.zip_code),
            status=request.status,
            customer_status=_customer_status(row),
            origin=request.origin,
            urgency=request.urgency,
            bucket=row.bucket,
            created_at=request.created_at,
            first_contact_due_at=request.created_at + self._sla,
            first_contact_at=request.first_contact_at,
            assigned_agent=agent,
            media_count=media_count,
        )

    async def _card(self, row: QueuedRequest, viewer: UserAccount) -> RequestCard:
        request = row
        [item] = await self._items([row])
        customer = await self._users.get_by_id(request.customer_id)
        address = await self._addresses.get(request.address_id)
        if customer is None or address is None:  # pragma: no cover - foreign keys hold both
            raise QueueRequestNotFoundError
        ttl = self._config.url_ttl_seconds
        expires_at = datetime.now(UTC) + timedelta(seconds=ttl)
        safe = await self._media.safe_media(request.id)
        media: list[CardMedia] = []
        if safe.ready:
            storage = self._storage()  # built only for a request that has media to sign
            for copy in safe.ready:
                signed = sign_safe_media(storage, copy, ttl, expires_at)
                if signed is not None:
                    media.append(
                        CardMedia(
                            kind=signed.kind,
                            content_type=signed.content_type,
                            url=signed.url,
                            expires_at=signed.expires_at,
                        )
                    )
        quotes = await self._quotes.of_request(request.id)
        pros = await self._pros.cards({quote.pro_id for quote in quotes})
        job = await self._jobs.of_request(request.id)
        starts = {quote.id: quote.proposed_start_at for quote in quotes}
        return RequestCard(
            **item.model_dump(),
            customer=CardCustomer(
                id=customer.id,
                first_name=customer.first_name,
                last_name=customer.last_name,
                phone=customer.phone,
                email=customer.email,
                language=request.language,
            ),
            address=address,
            description=request.description,
            intake_answers=request.intake_answers,
            preferred_date=request.preferred_date,
            preferred_period=request.preferred_period,
            preferred_contact=request.preferred_contact,
            media=media,
            media_pending=safe.pending,
            quotes=[
                CardQuote(
                    id=quote.id,
                    pro_name=pros[quote.pro_id].name if quote.pro_id in pros else None,
                    amount_cents=quote.amount_cents,
                    status=quote.status,
                    proposed_start_at=quote.proposed_start_at,
                    created_at=quote.created_at,
                )
                for quote in quotes
            ],
            job=None if job is None else _card_job(job, starts.get(job.quote_id)),
            next_action=request.next_action,
            last_contact_at=request.last_contact_at,
            updated_at=request.updated_at,
            notes=await self._records.notes_of(request.id),
            followups=await self._records.followups_of(request.id, viewer),
        )


def _customer_status(row: QueuedRequest) -> str:
    """What the customer sees: the job's status once there is a job, else the request's."""
    if row.job_status is not None:
        return CUSTOMER_STATUS[JobStatus(row.job_status)]
    return REQUEST_CUSTOMER_STATUS[row.status]


def _card_job(job: StaffJob, scheduled_start_at: datetime | None) -> CardJob:
    return CardJob(
        id=job.id,
        status=job.status,
        scheduled_start_at=scheduled_start_at,
        started_at=job.started_at,
        completed_at=job.completed_at,
        confirmed_at=job.confirmed_at,
        events=[
            CardJobEvent(
                type=event.type,
                from_status=event.from_status,
                to_status=event.to_status,
                by_system=event.by_system,
                created_at=event.created_at,
            )
            for event in job.events
        ],
    )


def _encode_cursor(request: QueuedRequest) -> str:
    raw = f"{request.created_at.isoformat()}|{request.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> After:
    """A cursor only positions the page: the queue is open to staff anyway."""
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        created_at, request_id = raw.split("|")
        decoded = datetime.fromisoformat(created_at)
        if decoded.tzinfo is None:
            raise ValueError("naive timestamp")
        return decoded.astimezone(UTC), uuid.UUID(request_id)
    except (binascii.Error, UnicodeDecodeError, ValueError, OverflowError):
        raise InvalidQueueQueryError from None
