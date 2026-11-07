"""Job chat, part 1 (D14.1, #71): the customer and the pro talk inside their job.

One thread per job, from the payment on (the job exists only once paid). There is no chat
before hiring: contacts are never exchanged off the app, and the thread after hiring replaces
any exchange (Cesar, 2026-10-28). Text only here; photos are part 2.

- Who: the job's customer and the user of the job's pro profile (JobPartiesReader, through the
  jobs service). Anyone else gets 404, the same body as an unknown job, so a stranger never
  learns that a job exists. Staff (agent, admin) read a thread through their own route, which
  never moves a read marker.
- Writing: the body goes through app.redaction.redact_contacts before it is stored, so no
  unredacted chat ever exists; `redacted` says whether anything was masked. A body with nothing
  left after cleaning is a 422. Only while the job is open (jobs.transitions.CHAT_OPEN); else
  409 chat_closed. The job row is locked FOR NO KEY UPDATE while the message is written, so a
  status change and a message on the same job run one after the other: a message never lands
  after the job closed (one waiting on a closing job reads it closed: 409), and messages commit
  in the order of their created_at, which is taken under that lock from the database clock. The
  read markers rely on that order. Rate-limited per user per job (the router).
- Reading: newest first by (created_at, id), with a cursor; plus the caller's unread count.
- Read markers: one per participant per job, moved forward only (never back), idempotent.
- Unread: the other side's messages after the caller's marker, all of them without one. The
  job views (customer and pro) show it per job (ChatUnreadReader).

Never logged: a body, or its masked parts. Logs carry ids, the length and `redacted`.
"""

import base64
import binascii
import logging
import uuid
from collections.abc import Collection, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import NotFoundError
from app.modules.chat.errors import ChatClosedError, InvalidChatInputError, InvalidMessageError
from app.modules.chat.models import MESSAGE_MAX_LENGTH, JobMessage
from app.modules.chat.repository import ChatRepository
from app.modules.chat.schemas import (
    ChatMessageOut,
    ChatPage,
    Sender,
    StaffChatMessageOut,
    StaffChatPage,
)
from app.modules.jobs.service import JobParties, JobPartiesReader
from app.modules.pros.service import ProService
from app.modules.users.types import UserAccount
from app.redaction import redact_contacts

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ChatConfig:
    list_default_limit: int
    list_max_limit: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "ChatConfig":
        return cls(
            list_default_limit=settings.request_list_default_limit,
            list_max_limit=settings.request_list_max_limit,
        )


class ChatUnreadReader:
    """Unread counts for the job views of another module (jobs)."""

    def __init__(self, session: AsyncSession) -> None:
        self._chat = ChatRepository(session)

    async def unread_counts(
        self, job_ids: Collection[uuid.UUID], user_id: uuid.UUID
    ) -> dict[uuid.UUID, int]:
        """Per job: the messages the others sent after the user's read marker; 0 when none."""
        counts = await self._chat.unread_counts(job_ids, user_id)
        return {job_id: counts.get(job_id, 0) for job_id in job_ids}


class ChatService:
    def __init__(self, session: AsyncSession, config: ChatConfig) -> None:
        self._session = session
        self._config = config
        self._chat = ChatRepository(session)
        self._jobs = JobPartiesReader(session, ProService(session))
        self._unread = ChatUnreadReader(session)

    async def messages(
        self, user: UserAccount, job_id: uuid.UUID, *, limit: int | None, cursor: str | None
    ) -> ChatPage:
        before = _decode_cursor(cursor) if cursor else None
        parties = await self._participant(user, job_id)
        page, next_cursor = await self._page(job_id, limit, before)
        unread = await self._unread.unread_counts([job_id], user.id)
        return ChatPage(
            items=[
                ChatMessageOut(
                    id=message.id,
                    sender=_side(message, parties, viewer=user.id),
                    body=message.body,
                    redacted=message.redacted,
                    created_at=message.created_at,
                )
                for message in page
            ],
            next_cursor=next_cursor,
            unread_count=unread[job_id],
        )

    async def send(self, user: UserAccount, job_id: uuid.UUID, body: str) -> ChatMessageOut:
        # Masked before the lock: the redactor is pure, and the lock stays short.
        result = redact_contacts(body)
        text = result.text.strip()
        parties = await self._jobs.parties(job_id, lock=True)
        if parties is None or not parties.includes(user.id):
            raise NotFoundError
        if not parties.chat_open:
            raise ChatClosedError
        if not text or len(text) > MESSAGE_MAX_LENGTH:
            # Nothing left once invisible characters are dropped, or (in theory) masks longer
            # than what they replaced past the limit.
            raise InvalidChatInputError
        message = await self._chat.add(
            JobMessage(
                job_id=job_id,
                sender_id=user.id,
                body=text,
                redacted=result.redacted,
                created_at=await self._chat.now(),
            )
        )
        await self._session.commit()
        side = _side(message, parties, viewer=None)
        logger.info(
            "job_message_sent",
            extra={
                "job_id": str(job_id),
                "message_id": str(message.id),
                "sender": side.value,
                "length": len(text),
                "redacted": result.redacted,
            },
        )
        return ChatMessageOut(
            id=message.id,
            sender=Sender.ME,
            body=message.body,
            redacted=message.redacted,
            created_at=message.created_at,
        )

    async def mark_read(self, user: UserAccount, job_id: uuid.UUID, up_to: uuid.UUID) -> int:
        """Moves the caller's marker to `up_to` when it is newer; the unread count after."""
        await self._participant(user, job_id)
        message = await self._chat.get_in_job(job_id, up_to)
        if message is None:
            raise InvalidMessageError
        await self._chat.move_marker(job_id, user.id, message)
        await self._session.commit()
        return (await self._unread.unread_counts([job_id], user.id))[job_id]

    async def staff_messages(
        self, staff: UserAccount, job_id: uuid.UUID, *, limit: int | None, cursor: str | None
    ) -> StaffChatPage:
        """The thread for the BDC and admins: read-only, no read marker moves."""
        before = _decode_cursor(cursor) if cursor else None
        parties = await self._jobs.parties(job_id)
        if parties is None:
            raise NotFoundError
        page, next_cursor = await self._page(job_id, limit, before)
        logger.info(
            "job_chat_read_by_staff",
            extra={"job_id": str(job_id), "staff_id": str(staff.id), "count": len(page)},
        )
        return StaffChatPage(
            items=[
                StaffChatMessageOut(
                    id=message.id,
                    sender=_side(message, parties, viewer=None),
                    body=message.body,
                    redacted=message.redacted,
                    created_at=message.created_at,
                )
                for message in page
            ],
            next_cursor=next_cursor,
        )

    async def _participant(self, user: UserAccount, job_id: uuid.UUID) -> JobParties:
        parties = await self._jobs.parties(job_id)
        if parties is None or not parties.includes(user.id):
            raise NotFoundError
        return parties

    async def _page(
        self, job_id: uuid.UUID, limit: int | None, before: tuple[datetime, uuid.UUID] | None
    ) -> tuple[Sequence[JobMessage], str | None]:
        """`limit` above the maximum is capped, not refused."""
        size = min(limit or self._config.list_default_limit, self._config.list_max_limit)
        rows = await self._chat.page(job_id, size + 1, before)
        page, more = rows[:size], len(rows) > size
        return page, _encode_cursor(page[-1]) if more and page else None


def _side(message: JobMessage, parties: JobParties, *, viewer: uuid.UUID | None) -> Sender:
    if viewer is not None and message.sender_id == viewer:
        return Sender.ME
    return Sender.CUSTOMER if message.sender_id == parties.customer_id else Sender.PRO


def _encode_cursor(message: JobMessage) -> str:
    raw = f"{message.created_at.isoformat()}|{message.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    """A cursor only positions the page inside the job's own thread: whatever it holds, the
    query never leaves the job."""
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        created_at, message_id = raw.split("|")
        decoded = datetime.fromisoformat(created_at)
        if decoded.tzinfo is None:
            raise ValueError("naive timestamp")
        return decoded.astimezone(UTC), uuid.UUID(message_id)
    except (binascii.Error, UnicodeDecodeError, ValueError, OverflowError):
        raise InvalidChatInputError from None
