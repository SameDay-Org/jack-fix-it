"""The waitlist's part of an account deletion (#97): every entry of the account goes, the ones
made signed in (its user id) and the ones made signed out with its email or phone."""

import uuid

from sqlalchemy import delete, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.waitlist.models import WaitlistEntry


async def forget_entries(
    session: AsyncSession, user_id: uuid.UUID, email: str, phone: str | None
) -> int:
    """Deletes the entries; how many. `email` is the account's (stored lowercase, as here)."""
    matches = [WaitlistEntry.user_id == user_id, WaitlistEntry.email == email]
    if phone is not None:
        matches.append(WaitlistEntry.phone == phone)
    result = await session.execute(
        delete(WaitlistEntry).where(or_(*matches)).execution_options(synchronize_session=False)
    )
    return int(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of a write
