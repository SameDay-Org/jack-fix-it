"""The quotes' part of an account deletion (#97): a pro's live quote blocks it, since a
deleted pro must never be hired. Quotes are kept untouched (an accepted one is the price the
job and its payment were made from).

There is no withdraw (#50 left it out): a pending quote blocks until it expires or is
decided; an accepted one while its request is still accepted without a job (the customer is
paying). Once its job exists the job's own rules apply; once the request is cancelled (by the
customer, or by the customer's own deletion) the quote holds nothing.
"""

import uuid

from sqlalchemy import Select, and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.quotes.models import Quote, QuoteStatus


async def pro_has_live_quote(
    session: AsyncSession,
    pro_id: uuid.UUID,
    *,
    quote_ids_with_a_job: Select[uuid.UUID],
    accepted_request_ids: Select[uuid.UUID],
) -> bool:
    """Whether the pro has a pending quote, or an accepted one on a request still accepted
    and with no job yet (jobs.erasure's and requests.erasure's statements): it is being paid."""
    statement = select(
        exists().where(
            Quote.pro_id == pro_id,
            or_(
                Quote.status == QuoteStatus.PENDING,
                and_(
                    Quote.status == QuoteStatus.ACCEPTED,
                    Quote.request_id.in_(accepted_request_ids),
                    Quote.id.not_in(quote_ids_with_a_job),
                ),
            ),
        )
    )
    return bool(await session.scalar(statement))
