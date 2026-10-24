import uuid
from collections.abc import Collection, Sequence
from datetime import datetime

from sqlalchemy import Select, func, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.requests.models import (
    MediaSafeStatus,
    RequestMedia,
    RequestStatus,
    ServiceRequest,
)


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

    async def get_for_update(self, request_id: uuid.UUID) -> ServiceRequest | None:
        """The request, locked until the transaction ends, so transitions on it run one at a
        time. populate_existing: a waiter gets the row as the transaction that held the lock
        left it."""
        statement = (
            select(ServiceRequest)
            .where(ServiceRequest.id == request_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def media_of(self, request_id: uuid.UUID) -> list[RequestMedia]:
        statement = (
            select(RequestMedia)
            .where(RequestMedia.request_id == request_id)
            .order_by(RequestMedia.created_at, RequestMedia.id)
        )
        return list((await self._session.scalars(statement)).all())

    async def pending_media(self, request_id: uuid.UUID) -> list[RequestMedia]:
        """The request's media still without a safe copy (#173)."""
        statement = (
            select(RequestMedia)
            .where(
                RequestMedia.request_id == request_id,
                RequestMedia.safe_status == MediaSafeStatus.PENDING,
            )
            .order_by(RequestMedia.created_at, RequestMedia.id)
        )
        return list((await self._session.scalars(statement)).all())

    async def fail_pending_media(self, media_ids: Collection[uuid.UUID]) -> list[uuid.UUID]:
        """Marks those of the media rows still pending failed (#173); the ids it changed."""
        statement = (
            update(RequestMedia)
            .where(
                RequestMedia.id.in_(media_ids),
                RequestMedia.safe_status == MediaSafeStatus.PENDING,
            )
            .values(safe_status=MediaSafeStatus.FAILED)
            .returning(RequestMedia.id)
            .execution_options(synchronize_session=False)
        )
        return list((await self._session.scalars(statement)).all())

    async def media_for_update(self, media_id: uuid.UUID) -> RequestMedia | None:
        """One media row, locked until the transaction ends, as the last writer left it."""
        statement = (
            select(RequestMedia)
            .where(RequestMedia.id == media_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

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

    @staticmethod
    def media_keys_among(keys: Collection[str]) -> Select[str]:
        """The file keys among `keys` that request media hold, for another module's query."""
        return select(RequestMedia.file_key).where(RequestMedia.file_key.in_(keys))

    @staticmethod
    def ids_with_status(statuses: Collection[RequestStatus]) -> Select[uuid.UUID]:
        """A subquery of the ids of requests in these statuses, for another module's query."""
        return select(ServiceRequest.id).where(ServiceRequest.status.in_(statuses))

    async def get_many(self, request_ids: Collection[uuid.UUID]) -> list[ServiceRequest]:
        if not request_ids:
            return []
        statement = select(ServiceRequest).where(ServiceRequest.id.in_(request_ids))
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
