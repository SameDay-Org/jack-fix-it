"""A pro's opportunities (D9.2, #49): the requests dispatched to them, and opening one.

A pro sees only their own dispatches that are still active (sent or viewed) on requests still
open for quotes (finding_pro, quote_ready). Anything else, another pro's included, answers the
same 404. The request comes through the requests module's pro-safe reader (ADR 0003), so no
customer, contact, street, coordinates, utm or BDC field ever reaches this module. Opening one
marks the dispatch viewed, once. Logs carry dispatch, request and pro ids only.
"""

import base64
import binascii
import logging
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import NotFoundError
from app.integrations.storage import Storage
from app.modules.categories.schemas import CategorySummary
from app.modules.categories.service import CategoryService
from app.modules.dispatch.models import DispatchStatus, RequestDispatch
from app.modules.dispatch.repository import DispatchRepository
from app.modules.dispatch.schemas import (
    OpportunityDetail,
    OpportunityLocation,
    OpportunityPage,
    OpportunitySummary,
)
from app.modules.pros.service import ProService
from app.modules.requests.errors import InvalidRequestError
from app.modules.requests.service import ProRequestReader, RequestForPro
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class OpportunityConfig:
    excerpt_chars: int
    list_default_limit: int
    list_max_limit: int
    media_url_ttl_seconds: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "OpportunityConfig":
        return cls(
            excerpt_chars=settings.opportunity_excerpt_chars,
            list_default_limit=settings.request_list_default_limit,
            list_max_limit=settings.request_list_max_limit,
            media_url_ttl_seconds=settings.download_url_ttl_seconds,
        )


class OpportunityService:
    def __init__(self, session: AsyncSession, storage: Storage, config: OpportunityConfig) -> None:
        self._session = session
        self._dispatches = DispatchRepository(session)
        self._requests = ProRequestReader(session, storage, config.media_url_ttl_seconds)
        self._categories = CategoryService(session)
        self._pros = ProService(session)
        self._config = config

    async def list_own(
        self, user: UserAccount, limit: int | None, cursor: str | None
    ) -> OpportunityPage:
        """Newest dispatch first. `limit` above the maximum is capped, not refused."""
        size = min(limit or self._config.list_default_limit, self._config.list_max_limit)
        before = _decode_cursor(cursor) if cursor else None
        pro_id = await self._pros.get_profile_id_for_user(user.id)
        if pro_id is None:  # no profile yet: nothing was ever dispatched to it
            return OpportunityPage(items=[], next_cursor=None)
        rows = await self._dispatches.page_for_pro(
            pro_id, ProRequestReader.open_ids(), size + 1, before
        )
        page, more = rows[:size], len(rows) > size
        views = await self._requests.open_views([row.request_id for row in page])
        categories = await self._category_summaries(views.values())
        items = [
            OpportunitySummary(
                dispatch_id=row.id,
                public_code=view.public_code,
                category=categories.get(view.category_id) if view.category_id else None,
                description_excerpt=view.description[: self._config.excerpt_chars],
                location=_location(view),
                preferred_date=view.preferred_date,
                media_count=view.media_count,
                sent_at=row.sent_at,
                viewed=row.status is DispatchStatus.VIEWED,
            )
            for row in page
            if (view := views.get(row.request_id)) is not None
        ]
        logger.info("opportunities_listed", extra={"pro_id": str(pro_id), "count": len(items)})
        return OpportunityPage(
            items=items, next_cursor=_encode_cursor(page[-1]) if more and page else None
        )

    async def open_own(self, user: UserAccount, dispatch_id: uuid.UUID) -> OpportunityDetail:
        """The detail; the first open marks the dispatch viewed, in this transaction, which it
        commits. 404, one body, for anything the pro may not open."""
        pro_id = await self._pros.get_profile_id_for_user(user.id)
        dispatch = (
            await self._dispatches.get_active_for_pro(dispatch_id, pro_id)
            if pro_id is not None
            else None
        )
        view = (
            (await self._requests.open_views([dispatch.request_id])).get(dispatch.request_id)
            if dispatch is not None
            else None
        )
        if dispatch is None or view is None or pro_id is None:
            raise NotFoundError
        first_view = await self._dispatches.mark_viewed(dispatch.id, datetime.now(UTC))
        viewed_at = await self._dispatches.viewed_at(dispatch.id)
        await self._session.commit()
        categories = await self._category_summaries([view])
        logger.info(
            "opportunity_opened",
            extra={
                "dispatch_id": str(dispatch.id),
                "service_request_id": str(view.id),
                "pro_id": str(pro_id),
                "first_view": first_view,
            },
        )
        return OpportunityDetail(
            dispatch_id=dispatch.id,
            public_code=view.public_code,
            category=categories.get(view.category_id) if view.category_id else None,
            description=view.description,
            intake_answers=view.intake_answers,
            location=_location(view),
            preferred_date=view.preferred_date,
            media=await self._requests.media(view.id),
            sent_at=dispatch.sent_at,
            viewed_at=viewed_at,
        )

    async def _category_summaries(
        self, views: Iterable[RequestForPro]
    ) -> dict[uuid.UUID, CategorySummary]:
        ids = {view.category_id for view in views if view.category_id is not None}
        return {summary.id: summary for summary in await self._categories.summaries(ids)}


def _location(view: RequestForPro) -> OpportunityLocation:
    return OpportunityLocation(zip_code=view.area.zip_code, city=view.area.city)


def _encode_cursor(dispatch: RequestDispatch) -> str:
    raw = f"{dispatch.sent_at.isoformat()}|{dispatch.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        sent_at, dispatch_id = raw.split("|")
        decoded = datetime.fromisoformat(sent_at)
        if decoded.tzinfo is None:
            raise ValueError("naive timestamp")
        return decoded.astimezone(UTC), uuid.UUID(dispatch_id)
    except (binascii.Error, UnicodeDecodeError, ValueError, OverflowError):
        raise InvalidRequestError from None
