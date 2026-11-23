"""The chat's part of an account deletion (#97): the messages stay for the other side (their
body was redacted when sent, and the sender shows as a side, never a name), but the sealed
originals of the account's messages, the text as typed, go now rather than at their expiry."""

import uuid

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.chat.models import JobMessage


async def forget_originals(session: AsyncSession, user_id: uuid.UUID) -> int:
    """Clears the originals of the messages the user sent; how many."""
    result = await session.execute(
        update(JobMessage)
        .where(JobMessage.sender_id == user_id, JobMessage.original_ciphertext.is_not(None))
        .values(original_ciphertext=None, original_key_id=None, original_expires_at=None)
        .execution_options(synchronize_session=False)
    )
    return int(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of a write
