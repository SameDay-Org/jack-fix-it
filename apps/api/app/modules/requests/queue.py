"""Requests for the operations queue (#81), through this module (ADR 0003): the queue's page,
one request, the bucket counts, and who holds a request. Reads, plus the one write the queue
makes: the assigned agent. A request's status is never touched here (RequestStateMachine).
"""

import uuid
from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.requests.models import ServiceRequest
from app.modules.requests.queue_repository import (
    After,
    QueueBucket,
    QueueFilters,
    QueueRow,
    QueueRules,
    QueueSources,
    RequestQueueRepository,
)
from app.modules.requests.repository import ServiceRequestRepository

__all__ = [
    "After",
    "QueueBucket",
    "QueueFilters",
    "QueueRow",
    "QueueRules",
    "QueueSources",
    "RequestQueueReader",
]


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
    ) -> list[QueueRow]:
        """One page: inside a bucket the request waiting longest first, else the newest."""
        return await self._queue.page(sources, rules, filters, limit=limit, after=after)

    async def one(
        self, request_id: uuid.UUID, sources: QueueSources, rules: QueueRules
    ) -> QueueRow | None:
        return await self._queue.one(request_id, sources, rules)

    async def counts(self, sources: QueueSources, rules: QueueRules) -> dict[QueueBucket, int]:
        """How many requests each bucket holds; a bucket with none is left out."""
        return await self._queue.counts(sources, rules)

    async def media_counts(self, request_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, int]:
        """How many photos and videos each request has; one with none is left out."""
        return await self._requests.media_counts(request_ids)

    async def lock(self, request_id: uuid.UUID) -> ServiceRequest | None:
        """The request as last committed, its row locked until the caller's transaction ends:
        two agents taking one request run one after the other."""
        return await self._requests.get_for_update(request_id)

    async def assign(self, request_id: uuid.UUID, agent_id: uuid.UUID | None) -> ServiceRequest:
        """Writes who holds the request (None: nobody). The caller holds its lock and commits."""
        return await self._queue.set_assigned_agent(request_id, agent_id)
