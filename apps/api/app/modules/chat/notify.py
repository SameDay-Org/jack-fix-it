"""The new-message push (#73 part 1, plan D14.4): to the other side of a job's chat, unless they
have it open (chat.presence).

The push names the job's code only, never the text, the sender or a masked part (the catalog's
lock-screen rule), and opens the job screen, whose chat entry shows the unread count: the
customer's job of their request, the pro's job. Announced after the message commits, so it never
fails or delays a stored message past one Redis call: presence fails toward the push, and the
queueing (notifications.events) logs and drops its own errors.
"""

import logging
import uuid
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends

from app.config import Settings, get_app_settings
from app.modules.chat.presence import ChatPresence, PushClaim, get_chat_presence
from app.modules.notifications.events import (
    push_chat_message_to_customer,
    push_chat_message_to_pro,
)
from app.queue import JobQueue, get_job_queue

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class NewMessage:
    """A committed message, and who it pushes to: plain values, read before the commit."""

    message_id: uuid.UUID
    job_id: uuid.UUID
    request_id: uuid.UUID
    public_code: str
    recipient_id: uuid.UUID
    to_customer: bool


class ChatNotifier:
    def __init__(
        self, presence: ChatPresence, queue: JobQueue, *, enqueue_timeout_seconds: float
    ) -> None:
        self._presence = presence
        self._queue = queue
        self._timeout = enqueue_timeout_seconds

    async def seen(self, job_id: uuid.UUID, user_id: uuid.UUID) -> None:
        """The participant has the job's chat open (they listed it or moved their marker)."""
        await self._presence.seen(job_id, user_id)

    async def announce(self, message: NewMessage) -> None:
        """One push to the recipient, unless they have the chat open or one went out to them for
        this job within the cooldown. Never raises."""
        claim = await self._presence.claim_push(message.job_id, message.recipient_id)
        if claim is not PushClaim.PUSH:
            logger.info(
                "chat_push_skipped",
                extra={
                    "job_id": str(message.job_id),
                    "message_id": str(message.message_id),
                    "reason": claim.value,
                },
            )
            return
        if message.to_customer:
            await push_chat_message_to_customer(
                self._queue,
                customer_id=message.recipient_id,
                chat_message_id=message.message_id,
                request_id=message.request_id,
                public_code=message.public_code,
                timeout_seconds=self._timeout,
            )
        else:
            await push_chat_message_to_pro(
                self._queue,
                pro_user_id=message.recipient_id,
                chat_message_id=message.message_id,
                job_id=message.job_id,
                public_code=message.public_code,
                timeout_seconds=self._timeout,
            )


def get_chat_notifier(
    presence: Annotated[ChatPresence, Depends(get_chat_presence)],
    queue: Annotated[JobQueue, Depends(get_job_queue)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> ChatNotifier:
    """FastAPI dependency: presence and the push queue on the app's Redis (tests override)."""
    return ChatNotifier(
        presence, queue, enqueue_timeout_seconds=settings.job_enqueue_timeout_seconds
    )
