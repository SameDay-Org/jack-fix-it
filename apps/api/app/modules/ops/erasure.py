"""The BDC's part of an account deletion (#97): staff's notes and follow-ups on a deleted
customer's requests stay (who wrote them, when, the follow-up's state), but their text is
replaced: the BDC writes the customer's name and phone there when they call. The deletion's
audit row (accounts) says how many."""

import uuid
from dataclasses import dataclass

from sqlalchemy import Select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.ops.models import RequestFollowup, RequestNote
from app.modules.users.types import ERASED_TEXT


@dataclass(frozen=True)
class ErasedNotes:
    notes: int
    followups: int


async def erase_notes(session: AsyncSession, request_ids: Select[uuid.UUID]) -> ErasedNotes:
    """Replaces the text of every note and follow-up on these requests (requests.erasure's
    statement of the customer's own)."""
    notes = await session.execute(
        update(RequestNote)
        .where(RequestNote.request_id.in_(request_ids))
        .values(body=ERASED_TEXT)
        .execution_options(synchronize_session=False)
    )
    followups = await session.execute(
        update(RequestFollowup)
        .where(RequestFollowup.request_id.in_(request_ids))
        .values(note=ERASED_TEXT)
        .execution_options(synchronize_session=False)
    )
    return ErasedNotes(
        notes=int(notes.rowcount),  # type: ignore[attr-defined]  # CursorResult of an UPDATE
        followups=int(followups.rowcount),  # type: ignore[attr-defined]  # likewise
    )
