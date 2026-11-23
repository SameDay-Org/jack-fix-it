"""The launch interest's part of an account deletion (#97, #590: Cesar's decision): the rows
with the account's email go with it. A row holds an email only (one row per email, stored
lowercase), never an account id, so the email is the match, as for a signed-out waitlist
entry (waitlist.erasure)."""

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.interest.models import LaunchInterest


async def forget_interest(session: AsyncSession, email: str) -> int:
    """Deletes the rows with `email` (the account's, stored lowercase, as here); how many."""
    result = await session.execute(
        delete(LaunchInterest)
        .where(LaunchInterest.email == email)
        .execution_options(synchronize_session=False)
    )
    return int(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of a write
