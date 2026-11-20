"""The operations queue's queries on service_requests (#81).

A request's bucket is computed in SQL, so the list can filter and page by it and the summary
can count it. What the bucket needs from other modules (the job, its scheduled start, the
pending quotes, the open support tickets, the ZIP) comes in as subqueries those modules
build (QueueSources): this module never names their tables.
"""

import uuid
from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Any

from sqlalchemy import (
    ColumnElement,
    Date,
    Select,
    Subquery,
    and_,
    case,
    cast,
    func,
    or_,
    select,
    tuple_,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.requests.models import RequestStatus, ServiceRequest

_R = ServiceRequest
_S = RequestStatus
# Where a page starts: strictly after this (created_at, id) in the page's direction.
After = tuple[datetime, uuid.UUID]


class QueueBucket(StrEnum):
    """The one bucket a request is in, by this precedence (the first that matches). `other`:
    none of them (accepted and unpaid, a job on another day, finished, cancelled, expired)."""

    PROBLEMS = "problems"
    URGENT = "urgent"
    NEW = "new"
    WAITING_CUSTOMER = "waiting_customer"
    WAITING_PRO = "waiting_pro"
    QUOTE_READY = "quote_ready"
    SCHEDULED_TODAY = "scheduled_today"
    OTHER = "other"


@dataclass(frozen=True)
class QueueSources:
    """What other modules contribute to the queue's query, as they name it.

    - `jobs`: request_id, job_id, quote_id, job_status (one row per request at most).
    - `quote_starts`: quote_id, start_at.
    - `pending_quotes`: request_id, pending, oldest_at (requests with a pending quote only).
    - `open_ticket_jobs`: the ids of jobs with a support ticket that is not closed.
    - `pro_cancelled_jobs`: the ids of jobs their pro cancelled recently (#69).
    - `zips`: address_id, zip_code.
    - `problem_job_statuses`: a job in one of these is a problem (disputed).
    - `active_job_statuses`: a job in one of these still has its visit ahead or under way.
    """

    jobs: Subquery
    quote_starts: Subquery
    pending_quotes: Subquery
    open_ticket_jobs: Select[uuid.UUID | None]
    pro_cancelled_jobs: Select[uuid.UUID]
    zips: Subquery
    problem_job_statuses: Collection[StrEnum]
    active_job_statuses: Collection[StrEnum]


@dataclass(frozen=True)
class QueueRules:
    """The thresholds, from the settings: how long the BDC has for the first contact, how long
    a pending quote may wait for its customer, and the time zone "today" is read in."""

    first_contact_sla: timedelta
    quote_waiting: timedelta
    time_zone: str


@dataclass(frozen=True)
class QueueFilters:
    """`bucket` None: every request. `assigned_to` and `unassigned` are exclusive."""

    bucket: QueueBucket | None = None
    status: RequestStatus | None = None
    category_id: uuid.UUID | None = None
    zip5: str | None = None
    assigned_to: uuid.UUID | None = None
    unassigned: bool = False
    code: str | None = None


@dataclass(frozen=True)
class QueueRow:
    """A request in the queue: its row, its bucket, its job's status (None without a job) and
    its ZIP as stored."""

    request: ServiceRequest
    bucket: QueueBucket
    job_status: str | None
    zip_code: str


def bucket_of(sources: QueueSources, rules: QueueRules) -> ColumnElement[str]:
    """A request's bucket, by the database clock.

    - problems: its job is disputed, a support ticket about its job is not closed, or its
      pro cancelled the job recently (OPS_PRO_CANCEL_ATTENTION_HOURS, #69).
    - urgent: received or reviewing, never contacted, and marked urgent or older than the
      first-contact time.
    - new: received and nobody took it.
    - waiting_customer: reviewing (the BDC asked for more), or quote ready with a pending quote
      older than the waiting time.
    - waiting_pro: finding a pro and no pending quote.
    - quote_ready: any other request with a quote ready.
    - scheduled_today: its job is still ahead or under way and starts today, in the business
      time zone.
    """
    jobs, pending, starts = sources.jobs.c, sources.pending_quotes.c, sources.quote_starts.c
    now = func.now()
    problems = or_(
        jobs.job_status.in_(sources.problem_job_statuses),
        jobs.job_id.in_(sources.open_ticket_jobs),
        jobs.job_id.in_(sources.pro_cancelled_jobs),
    )
    urgent = and_(
        _R.status.in_((_S.RECEIVED, _S.REVIEWING)),
        _R.first_contact_at.is_(None),
        or_(_R.urgency.is_not(None), _R.created_at < now - rules.first_contact_sla),
    )
    new = and_(_R.status == _S.RECEIVED, _R.assigned_agent_id.is_(None))
    waiting_customer = or_(
        _R.status == _S.REVIEWING,
        and_(_R.status == _S.QUOTE_READY, pending.oldest_at < now - rules.quote_waiting),
    )
    waiting_pro = and_(_R.status == _S.FINDING_PRO, func.coalesce(pending.pending, 0) == 0)
    scheduled_today = and_(
        jobs.job_status.in_(sources.active_job_statuses),
        cast(func.timezone(rules.time_zone, starts.start_at), Date)
        == cast(func.timezone(rules.time_zone, now), Date),
    )
    return case(
        (problems, QueueBucket.PROBLEMS.value),
        (urgent, QueueBucket.URGENT.value),
        (new, QueueBucket.NEW.value),
        (waiting_customer, QueueBucket.WAITING_CUSTOMER.value),
        (waiting_pro, QueueBucket.WAITING_PRO.value),
        (_R.status == _S.QUOTE_READY, QueueBucket.QUOTE_READY.value),
        (scheduled_today, QueueBucket.SCHEDULED_TODAY.value),
        else_=QueueBucket.OTHER.value,
    )


class RequestQueueRepository:
    """Queries only. A request's status never changes here (RequestStateMachine)."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def page(
        self,
        sources: QueueSources,
        rules: QueueRules,
        filters: QueueFilters,
        *,
        limit: int,
        after: After | None,
    ) -> list[QueueRow]:
        """One page of the queue. Inside a bucket the request waiting longest comes first
        (oldest by created_at, id); without one, the newest."""
        bucket = bucket_of(sources, rules)
        statement = self._joined(
            select(_R, bucket, sources.jobs.c.job_status, sources.zips.c.zip_code), sources
        )
        if filters.bucket is not None:
            statement = statement.where(bucket == filters.bucket.value)
        if filters.status is not None:
            statement = statement.where(_R.status == filters.status)
        if filters.category_id is not None:
            statement = statement.where(_R.category_id == filters.category_id)
        if filters.zip5 is not None:
            # Stored as 5 digits or ZIP+4: the first five are the ZIP.
            statement = statement.where(func.left(sources.zips.c.zip_code, 5) == filters.zip5)
        if filters.assigned_to is not None:
            statement = statement.where(_R.assigned_agent_id == filters.assigned_to)
        if filters.unassigned:
            statement = statement.where(_R.assigned_agent_id.is_(None))
        if filters.code is not None:
            statement = statement.where(_R.public_code.contains(filters.code, autoescape=True))
        position = tuple_(_R.created_at, _R.id)
        if filters.bucket is None:
            if after is not None:
                statement = statement.where(position < tuple_(*after))
            statement = statement.order_by(_R.created_at.desc(), _R.id.desc())
        else:
            if after is not None:
                statement = statement.where(position > tuple_(*after))
            statement = statement.order_by(_R.created_at, _R.id)
        rows = (await self._session.execute(statement.limit(limit))).all()
        return [_row(row[0], row[1], row[2], row[3]) for row in rows]

    async def one(
        self, request_id: uuid.UUID, sources: QueueSources, rules: QueueRules
    ) -> QueueRow | None:
        """One request as the queue sees it, or None when there is none."""
        statement = self._joined(
            select(
                _R,
                bucket_of(sources, rules),
                sources.jobs.c.job_status,
                sources.zips.c.zip_code,
            ),
            sources,
        ).where(_R.id == request_id)
        found = (await self._session.execute(statement)).one_or_none()
        return None if found is None else _row(found[0], found[1], found[2], found[3])

    async def counts(self, sources: QueueSources, rules: QueueRules) -> dict[QueueBucket, int]:
        """How many requests each bucket holds; a bucket with none is left out."""
        bucket = bucket_of(sources, rules).label("bucket")
        statement = self._joined(select(bucket, func.count()), sources, with_zip=False).group_by(
            bucket
        )
        return {
            QueueBucket(value): count
            for value, count in (await self._session.execute(statement)).all()
        }

    async def set_assigned_agent(self, request: ServiceRequest, agent_id: uuid.UUID | None) -> None:
        """Writes who holds the request (None: nobody) on the row the caller locked
        (get_for_update). Through the row, not an UPDATE statement: statements on
        service_requests belong to the state machine (#160)."""
        request.assigned_agent_id = agent_id
        await self._session.flush()

    async def set_first_contact(self, request: ServiceRequest, at: datetime) -> None:
        """Writes the first contact time on the row the caller locked; through the row, as
        set_assigned_agent."""
        request.first_contact_at = at
        await self._session.flush()

    async def set_category(self, request: ServiceRequest, category_id: uuid.UUID) -> None:
        """Writes the category on the row the caller locked; through the row, as
        set_assigned_agent."""
        request.category_id = category_id
        await self._session.flush()

    @staticmethod
    def _joined[S: Select[*tuple[Any, ...]]](
        statement: S, sources: QueueSources, *, with_zip: bool = True
    ) -> S:
        """`statement` over every request with its job, that job's start and its pending
        quotes when it has them; with `with_zip`, joined to the address's ZIP too."""
        jobs, starts, pending = sources.jobs, sources.quote_starts, sources.pending_quotes
        statement = (
            statement.select_from(_R)
            .outerjoin(jobs, jobs.c.request_id == _R.id)
            .outerjoin(starts, starts.c.quote_id == jobs.c.quote_id)
            .outerjoin(pending, pending.c.request_id == _R.id)
        )
        if with_zip:
            statement = statement.join(sources.zips, sources.zips.c.address_id == _R.address_id)
        return statement


def _row(request: ServiceRequest, bucket: str, job_status: object, zip_code: str) -> QueueRow:
    return QueueRow(
        request=request,
        bucket=QueueBucket(bucket),
        job_status=None if job_status is None else str(getattr(job_status, "value", job_status)),
        zip_code=zip_code,
    )
