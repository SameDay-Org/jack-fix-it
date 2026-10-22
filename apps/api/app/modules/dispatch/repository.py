import uuid
from collections.abc import Collection, Sequence
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import Select, exists, func, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.dispatch.models import DispatchStatus, RequestDispatch

# Dispatches a pro still acts on: not declined, quoted or expired.
ACTIVE: frozenset[DispatchStatus] = frozenset({DispatchStatus.SENT, DispatchStatus.VIEWED})


@dataclass(frozen=True)
class ProHistory:
    """A pro's past dispatches: how fast they answer, and when they last got a request."""

    avg_response_seconds: float | None  # None until the first answer
    last_sent_at: datetime | None  # None when never dispatched


class DispatchRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def exists_for(self, request_id: uuid.UUID) -> bool:
        statement = select(exists().where(RequestDispatch.request_id == request_id))
        return bool(await self._session.scalar(statement))

    async def add_many(self, rows: Sequence[RequestDispatch]) -> None:
        """Inserts now (flush): a duplicate (request, pro) fails here, inside the transaction."""
        self._session.add_all(rows)
        await self._session.flush()

    async def history(self, pro_ids: Collection[uuid.UUID]) -> dict[uuid.UUID, ProHistory]:
        """Per pro with any past dispatch; pros never dispatched are absent."""
        if not pro_ids:
            return {}
        response_seconds = func.extract(
            "epoch", RequestDispatch.responded_at - RequestDispatch.sent_at
        )
        statement = (
            select(
                RequestDispatch.pro_id,
                func.avg(response_seconds).filter(RequestDispatch.responded_at.is_not(None)),
                func.max(RequestDispatch.sent_at),
            )
            .where(RequestDispatch.pro_id.in_(pro_ids))
            .group_by(RequestDispatch.pro_id)
        )
        return {
            pro_id: ProHistory(
                avg_response_seconds=float(average) if average is not None else None,
                last_sent_at=last_sent_at,
            )
            for pro_id, average, last_sent_at in (await self._session.execute(statement)).all()
        }

    async def page_for_pro(
        self,
        pro_id: uuid.UUID,
        open_requests: Select[uuid.UUID],
        limit: int,
        before: tuple[datetime, uuid.UUID] | None,
    ) -> list[RequestDispatch]:
        """The pro's active dispatches on open requests, newest first (sent_at, then id)."""
        statement = select(RequestDispatch).where(
            RequestDispatch.pro_id == pro_id,
            RequestDispatch.status.in_(ACTIVE),
            RequestDispatch.request_id.in_(open_requests),
        )
        if before is not None:
            statement = statement.where(
                tuple_(RequestDispatch.sent_at, RequestDispatch.id) < tuple_(*before)
            )
        statement = statement.order_by(
            RequestDispatch.sent_at.desc(), RequestDispatch.id.desc()
        ).limit(limit)
        return list((await self._session.scalars(statement)).all())

    async def get_active_for_pro(
        self, dispatch_id: uuid.UUID, pro_id: uuid.UUID
    ) -> RequestDispatch | None:
        statement = select(RequestDispatch).where(
            RequestDispatch.id == dispatch_id,
            RequestDispatch.pro_id == pro_id,
            RequestDispatch.status.in_(ACTIVE),
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def mark_viewed(self, dispatch_id: uuid.UUID, now: datetime) -> bool:
        """sent -> viewed, once: a conditional UPDATE, so two first opens set it once. Seeing
        it is the pro's first answer (responded_at). True when this call made the change."""
        statement = (
            update(RequestDispatch)
            .where(RequestDispatch.id == dispatch_id, RequestDispatch.status == DispatchStatus.SENT)
            .values(
                status=DispatchStatus.VIEWED,
                viewed_at=now,
                responded_at=func.coalesce(RequestDispatch.responded_at, now),
            )
            .returning(RequestDispatch.id)
            .execution_options(synchronize_session=False)
        )
        return (await self._session.scalar(statement)) is not None

    async def viewed_at(self, dispatch_id: uuid.UUID) -> datetime | None:
        statement = select(RequestDispatch.viewed_at).where(RequestDispatch.id == dispatch_id)
        return await self._session.scalar(statement)
