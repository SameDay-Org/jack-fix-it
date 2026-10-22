import uuid
from collections.abc import Collection, Sequence
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.dispatch.models import RequestDispatch


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
