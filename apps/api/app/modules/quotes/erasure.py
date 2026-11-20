"""The quotes' part of an account deletion (#97): a pro's live quote blocks it, since a
deleted pro must never be hired. Quotes are kept untouched (an accepted one is the price the
job and its payment were made from).

There is no withdraw (#50 left it out): a pending quote blocks until it expires or is
decided; an accepted one until its job exists (the payment went through) or it falls back.
"""

import uuid

from sqlalchemy import Select, and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.quotes.models import Quote, QuoteStatus


async def pro_has_live_quote(
    session: AsyncSession, pro_id: uuid.UUID, quote_ids_with_a_job: Select[uuid.UUID]
) -> bool:
    """Whether the pro has a pending quote, or an accepted one with no job yet (jobs.erasure's
    statement): the customer is paying it."""
    statement = select(
        exists().where(
            Quote.pro_id == pro_id,
            or_(
                Quote.status == QuoteStatus.PENDING,
                and_(Quote.status == QuoteStatus.ACCEPTED, Quote.id.not_in(quote_ids_with_a_job)),
            ),
        )
    )
    return bool(await session.scalar(statement))
