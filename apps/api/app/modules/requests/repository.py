import uuid
from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.requests.models import RequestMedia, ServiceRequest


class ServiceRequestRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, request: ServiceRequest) -> ServiceRequest:
        """Inserts now (flush), so the database-generated id and public_code are set."""
        self._session.add(request)
        await self._session.flush()
        return request

    async def add_media(self, media: Sequence[RequestMedia]) -> None:
        """Inserts now (flush), so a reused file_key surfaces here as a unique violation."""
        self._session.add_all(media)
        await self._session.flush()

    async def get(self, request_id: uuid.UUID) -> ServiceRequest | None:
        return await self._session.get(ServiceRequest, request_id)

    async def media_of(self, request_id: uuid.UUID) -> list[RequestMedia]:
        statement = (
            select(RequestMedia)
            .where(RequestMedia.request_id == request_id)
            .order_by(RequestMedia.created_at, RequestMedia.id)
        )
        return list((await self._session.scalars(statement)).all())

    async def page_of_customer(
        self,
        customer_id: uuid.UUID,
        limit: int,
        before: tuple[datetime, uuid.UUID] | None,
    ) -> list[ServiceRequest]:
        """Newest first, by (created_at, id); `before` continues after the last item seen."""
        statement = select(ServiceRequest).where(ServiceRequest.customer_id == customer_id)
        if before is not None:
            statement = statement.where(
                tuple_(ServiceRequest.created_at, ServiceRequest.id) < tuple_(*before)
            )
        statement = statement.order_by(
            ServiceRequest.created_at.desc(), ServiceRequest.id.desc()
        ).limit(limit)
        return list((await self._session.scalars(statement)).all())

    async def media_counts(self, request_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, int]:
        if not request_ids:
            return {}
        statement = (
            select(RequestMedia.request_id, func.count())
            .where(RequestMedia.request_id.in_(request_ids))
            .group_by(RequestMedia.request_id)
        )
        return {request_id: count for request_id, count in (await self._session.execute(statement))}
