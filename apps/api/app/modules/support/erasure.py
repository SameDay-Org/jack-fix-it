"""The support tickets' part of an account deletion (#97): a ticket stays (staff's record of
it, its status and topic), but its message, stored as typed, is replaced, and the fingerprint
of the body that came with it goes."""

import uuid

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.support.models import SupportTicket
from app.modules.users.types import ERASED_TEXT


async def erase_messages(session: AsyncSession, user_id: uuid.UUID) -> int:
    """Replaces the message of every ticket of the user; how many."""
    result = await session.execute(
        update(SupportTicket)
        .where(SupportTicket.user_id == user_id)
        .values(message=ERASED_TEXT, idempotency_key=None, idempotency_fingerprint=None)
        .execution_options(synchronize_session=False)
    )
    return int(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of a write
