"""Requests for the operations queue (#81), through this module (ADR 0003): the queue's page,
one request, the bucket counts, and who holds a request. What leaves is plain values
(QueuedRequest), never the ORM row. Reads, plus the one write the queue makes: the assigned
agent. A request's status is never touched here (RequestStateMachine).
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, datetime

from pydantic import JsonValue
from sqlalchemy.ext.asyncio import AsyncSession

# Re-exported: the queue's callers name these through this module (ADR 0003).
from app.modules.requests.models import PreferredPeriod as PreferredPeriod
from app.modules.requests.models import RequestMediaKind as RequestMediaKind
from app.modules.requests.models import RequestOrigin as RequestOrigin
from app.modules.requests.models import RequestStatus as RequestStatus
from app.modules.requests.models import ServiceRequest
from app.modules.requests.queue_repository import After as After
from app.modules.requests.queue_repository import QueueBucket as QueueBucket
from app.modules.requests.queue_repository import QueueFilters as QueueFilters
from app.modules.requests.queue_repository import QueueRow, RequestQueueRepository
from app.modules.requests.queue_repository import QueueRules as QueueRules
from app.modules.requests.queue_repository import QueueSources as QueueSources
from app.modules.requests.repository import ServiceRequestRepository


@dataclass(frozen=True)
class QueuedRequest:
    """A request as the operations queue reads it: its own columns, its bucket, its job's
    status (None without a job) and its ZIP as stored. Staff only: the description and the
    answers are the customer's text as typed."""

    id: uuid.UUID
    public_code: str
    customer_id: uuid.UUID
    category_id: uuid.UUID | None
    address_id: uuid.UUID
    description: str
    intake_answers: dict[str, JsonValue]
    urgency: str | None
    preferred_contact: str | None
    preferred_date: date | None
    preferred_period: PreferredPeriod | None
    language: str
    status: RequestStatus
    origin: RequestOrigin
    assigned_agent_id: uuid.UUID | None
    next_action: str | None
    first_contact_at: datetime | None
    last_contact_at: datetime | None
    created_at: datetime
    updated_at: datetime
    bucket: QueueBucket
    job_status: str | None
    zip_code: str


@dataclass(frozen=True)
class LockedRequest:
    """A request whose row this transaction holds FOR UPDATE: its id and who holds it now.
    Handed back to `RequestQueueReader.assign` to change the holder."""

    id: uuid.UUID
    assigned_agent_id: uuid.UUID | None
    _row: ServiceRequest = field(repr=False, compare=False)


class RequestQueueReader:
    """The caller is the operations queue, which checks that the reader is staff."""

    def __init__(self, session: AsyncSession) -> None:
        self._queue = RequestQueueRepository(session)
        self._requests = ServiceRequestRepository(session)

    async def page(
        self,
        sources: QueueSources,
        rules: QueueRules,
        filters: QueueFilters,
        *,
        limit: int,
        after: After | None,
    ) -> list[QueuedRequest]:
        """One page: inside a bucket the request waiting longest first, else the newest."""
        rows = await self._queue.page(sources, rules, filters, limit=limit, after=after)
        return [_queued(row) for row in rows]

    async def one(
        self, request_id: uuid.UUID, sources: QueueSources, rules: QueueRules
    ) -> QueuedRequest | None:
        row = await self._queue.one(request_id, sources, rules)
        return None if row is None else _queued(row)

    async def counts(self, sources: QueueSources, rules: QueueRules) -> dict[QueueBucket, int]:
        """How many requests each bucket holds; a bucket with none is left out."""
        return await self._queue.counts(sources, rules)

    async def media_counts(self, request_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, int]:
        """How many photos and videos each request has; one with none is left out."""
        return await self._requests.media_counts(request_ids)

    async def lock(self, request_id: uuid.UUID) -> LockedRequest | None:
        """The request as last committed, its row locked until the caller's transaction ends:
        two agents taking one request run one after the other. None for an unknown request."""
        request = await self._requests.get_for_update(request_id)
        if request is None:
            return None
        return LockedRequest(request.id, request.assigned_agent_id, request)

    async def assign(self, locked: LockedRequest, agent_id: uuid.UUID | None) -> None:
        """Writes who holds the locked request (None: nobody). The caller commits."""
        await self._queue.set_assigned_agent(locked._row, agent_id)


def _queued(row: QueueRow) -> QueuedRequest:
    request = row.request
    return QueuedRequest(
        id=request.id,
        public_code=request.public_code,
        customer_id=request.customer_id,
        category_id=request.category_id,
        address_id=request.address_id,
        description=request.description,
        intake_answers=request.intake_answers,
        urgency=request.urgency,
        preferred_contact=request.preferred_contact,
        preferred_date=request.preferred_date,
        preferred_period=request.preferred_period,
        language=request.language,
        status=request.status,
        origin=request.origin,
        assigned_agent_id=request.assigned_agent_id,
        next_action=request.next_action,
        first_contact_at=request.first_contact_at,
        last_contact_at=request.last_contact_at,
        created_at=request.created_at,
        updated_at=request.updated_at,
        bucket=row.bucket,
        job_status=row.job_status,
        zip_code=row.zip_code,
    )
