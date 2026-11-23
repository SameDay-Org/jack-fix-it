"""The disputes' part of an account deletion (#97): an open dispute blocks it. Disputes are
kept untouched (their text is stored redacted already); the parties are anonymised in place."""

import uuid

from sqlalchemy import Select, exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.disputes.models import Dispute, DisputeStatus


async def has_open_dispute(session: AsyncSession, job_ids: Select[uuid.UUID]) -> bool:
    """Whether one of these jobs (jobs.erasure's statement) has an open dispute."""
    statement = select(
        exists().where(Dispute.job_id.in_(job_ids), Dispute.status == DisputeStatus.OPEN)
    )
    return bool(await session.scalar(statement))
