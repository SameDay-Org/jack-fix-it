"""Worker side of the chat (#72): the cron that deletes the originals past their retention.

The original of a redacted message is kept, encrypted, until its `original_expires_at`
(CHAT_ORIGINAL_RETENTION_DAYS after the message). A run takes one `now` and clears the three
original_* columns of the messages due at or before it, CHAT_ORIGINAL_PURGE_BATCH rows per
transaction, oldest first, skipping rows another transaction holds; each batch commits on its
own, so a batch that fails leaves the ones before it purged and ends the run (the next run
takes the rest). Nothing raises out of the cron. One `chat_originals_purged` summary per run,
with counts only: no ids of messages, no text.
"""

import logging
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.chat.repository import ChatRepository

logger = logging.getLogger(__name__)

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


async def purge_chat_originals(ctx: dict[str, Any]) -> None:
    """ARQ cron: clears the chat originals past their retention (see the module doc)."""
    settings: Settings = ctx["settings"]
    await purge_expired_originals(
        ctx["session_factory"], datetime.now(UTC), settings.chat_original_purge_batch
    )


async def purge_expired_originals(sessions: SessionFactory, now: datetime, batch: int) -> int:
    """Clears every original due at or before `now`, `batch` rows per transaction; how many."""
    purged = batches = 0
    failed = False
    try:
        while True:
            try:
                async with sessions() as session:
                    cleared = await ChatRepository(session).clear_expired_originals(now, batch)
                    await session.commit()
            # By class only: a database error's text can hold SQL literals.
            except Exception as error:  # noqa: BLE001
                failed = True
                logger.error("chat_originals_purge_failed", extra={"error": type(error).__name__})
                return purged
            purged += cleared
            batches += 1
            if cleared < batch:
                return purged
    finally:
        logger.info(
            "chat_originals_purged",
            extra={"purged": purged, "batches": batches, "failed": failed},
        )
