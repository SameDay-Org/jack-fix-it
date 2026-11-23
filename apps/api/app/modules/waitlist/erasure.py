"""The waitlist's part of an account deletion (#97): every entry of the account goes, the ones
made signed in (its user id) and the ones made signed out (no user id) with its email or phone.
An entry another account made, whatever contact it holds, is that account's."""

import uuid

from sqlalchemy import and_, delete, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.waitlist.models import WaitlistEntry


async def forget_entries(
    session: AsyncSession, user_id: uuid.UUID, email: str, phone: str | None
) -> int:
    """Deletes the entries; how many. `email` is the account's (stored lowercase, as here)."""
    contacts = [WaitlistEntry.email == email]
    if phone is not None:
        contacts.append(WaitlistEntry.phone == phone)
    signed_out = and_(WaitlistEntry.user_id.is_(None), or_(*contacts))
    result = await session.execute(
        delete(WaitlistEntry)
        .where(or_(WaitlistEntry.user_id == user_id, signed_out))
        .execution_options(synchronize_session=False)
    )
    return int(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of a write
