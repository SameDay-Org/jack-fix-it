"""Job chat, part 1 (D14.1, #71): the customer and the pro talk inside their job.

One thread per job, from the payment on (the job exists only once paid). There is no chat
before hiring: contacts are never exchanged off the app, and the thread after hiring replaces
any exchange (Cesar, 2026-10-28). Text only here; photos are part 2.

- Who: the job's customer and the user of the job's pro profile (JobPartiesReader, through the
  jobs service). Anyone else gets 404, the same body as an unknown job, so a stranger never
  learns that a job exists. Staff (agent, admin) read a thread through their own route, which
  never moves a read marker.
- Writing: the body goes through app.redaction.redact_contacts before it is stored, so the
  participants never see unredacted text; `redacted` says whether anything was masked. A body
  with nothing left after cleaning is a 422. Only while the job is open
  (jobs.transitions.CHAT_OPEN); else 409 chat_closed. The job row is locked FOR NO KEY UPDATE
  while the message is written, so a status change and a message on the same job run one after
  the other: a message never lands after the job closed (one waiting on a closing job reads it
  closed: 409), and messages commit in the order of their created_at, which is taken under that
  lock from the database clock. The read markers rely on that order. Rate-limited per user per
  job (the router).
- The original of a redacted message (#72, Cesar 2026-11-07): sealed with app.crypto
  (AES-256-GCM, the message id as associated data) in the message's transaction, kept for
  CHAT_ORIGINAL_RETENTION_DAYS (the worker's purge_chat_originals clears it), shown to staff
  only. Without a configured key none is kept (fail closed; main logs it at startup). The
  sender's answer carries `warning: contact_details_hidden` whenever something was masked.
- Repeat offenders (#72): after a redacted message commits, the sender's redacted messages in
  every job within CHAT_OFFENDER_WINDOW_DAYS are counted; from CHAT_OFFENDER_THRESHOLD on, the
  sender's one open flag is opened (ERROR chat_offender_flagged, ids only) or its count raised.
  Counted after the commit, so of concurrent messages the last to count sees all the others. A
  check that fails is logged and never fails the message, which is stored already.
- Staff reads (#71, #72): any job's thread, with the originals still kept and not expired. A
  response that carries one writes an audit_log row (the reader, the job, the message ids and
  the count), committed before the answer; an original that does not open is null, logged with
  ids only.
- Reading: newest first by (created_at, id), with a cursor; plus the caller's unread count.
- Read markers: one per participant per job, moved forward only (never back), idempotent.
- Receipts (#331, Cesar 2026-11-07: one tick sent, two received, blue seen): each participant
  also has a delivered marker, moved forward when their app lists the thread: to the newest
  message of the other side in the page, written only when that message was not delivered to
  them yet (any page: forward-only makes older pages no-ops). Reading implies delivered
  without moving it: a message at or behind the read marker is seen. The caller's own
  messages carry `receipt` from the other side's markers (seen, delivered, sent), the other
  side's carry null; staff see every message's. A push reaching a device does not count as
  delivered here: only a listing does. The delivered markers have a table of their own
  (job_chat_deliveries) so the API version before them keeps working during a deploy.
- Unread: the other side's messages after the caller's marker, all of them without one. The
  job views (customer and pro) show it per job (ChatUnreadReader).

Never logged: a body, an original, or their masked parts. Logs carry ids, the length,
`redacted` and counts.
"""

import base64
import binascii
import logging
import uuid
from collections.abc import Collection, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.crypto import DecryptionError, OriginalCipher, Sealed
from app.errors import NotFoundError
from app.modules.audit.service import AuditService
from app.modules.audit.types import AuditAction, AuditEntity, AuditEntityType
from app.modules.chat.errors import ChatClosedError, InvalidChatInputError, InvalidMessageError
from app.modules.chat.models import MESSAGE_MAX_LENGTH, ChatOffenderFlag, JobMessage, Receipt
from app.modules.chat.repository import ChatRepository, MessageRow
from app.modules.chat.schemas import (
    ChatMessageOut,
    ChatOffenderFlagOut,
    ChatOffenderFlagPage,
    ChatPage,
    ChatWarning,
    Sender,
    SentMessageOut,
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
    # None: no key configured, so no original is kept (fail closed).
    original_cipher: OriginalCipher | None
    original_retention: timedelta
    offender_threshold: int
    offender_window_seconds: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "ChatConfig":
        return cls(
            list_default_limit=settings.request_list_default_limit,
            list_max_limit=settings.request_list_max_limit,
            original_cipher=settings.chat_original_cipher(),
            original_retention=timedelta(days=settings.chat_original_retention_days),
            offender_threshold=settings.chat_offender_threshold,
            offender_window_seconds=settings.chat_offender_window_days * 24 * 60 * 60,
        )


def original_associated_data(message_id: uuid.UUID) -> bytes:
    """What an original is bound to: its own message (a ciphertext moved to another row does
    not open)."""
    return b"job_messages.original:" + message_id.bytes


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
        page, next_cursor = await self._page(parties, limit, before)
        # Newest first: the first message of the other side is the newest the caller received.
        # Its receipt is from the caller's own markers: "sent" means their delivered marker is
        # behind it (or absent). Otherwise nothing is written.
        received = next((row for row in page if row.message.sender_id != user.id), None)
        if received is not None and received.receipt is Receipt.SENT:
            await self._chat.move_delivered(job_id, user.id, received.message)
            await self._session.commit()
        unread = await self._unread.unread_counts([job_id], user.id)
        return ChatPage(
            items=[
                ChatMessageOut(
                    id=row.message.id,
                    sender=_side(row.message, parties, viewer=user.id),
                    body=row.message.body,
                    redacted=row.message.redacted,
                    created_at=row.message.created_at,
                    receipt=row.receipt if row.message.sender_id == user.id else None,
                )
                for row in page
            ],
            next_cursor=next_cursor,
            unread_count=unread[job_id],
        )

    async def send(self, user: UserAccount, job_id: uuid.UUID, body: str) -> SentMessageOut:
        # A stranger gets 404 before any redactor work (the rate limit is per job, so a stranger
        # trying new job ids is never limited). Masked before the lock: the redactor is pure,
        # and the lock stays short. The lock reads the parties again.
        await self._participant(user, job_id)
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
        cipher = self._config.original_cipher
        if result.redacted and cipher is not None:
            # The id exists once inserted (ADR 0007): the original is sealed to it in the same
            # transaction, so a redacted message never commits without its original.
            sealed = cipher.encrypt(body, original_associated_data(message.id))
            message.original_ciphertext = sealed.ciphertext
            message.original_key_id = sealed.key_id
            message.original_expires_at = message.created_at + self._config.original_retention
            await self._session.flush()
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
                "original_kept": message.original_ciphertext is not None,
            },
        )
        sent = SentMessageOut(
            id=message.id,
            sender=Sender.ME,
            body=message.body,
            redacted=message.redacted,
            created_at=message.created_at,
            receipt=Receipt.SENT,
            warning=ChatWarning.CONTACT_DETAILS_HIDDEN if result.redacted else None,
        )
        # After the answer is built: a failed check rolls the session back, which expires the
        # message.
        if result.redacted:
            await self._check_offender(user.id, job_id)
        return sent

    async def _check_offender(self, sender_id: uuid.UUID, job_id: uuid.UUID) -> None:
        """Opens or raises the sender's flag once their redacted messages within the window
        reach the threshold (see the module doc). Never raises: the message is stored."""
        try:
            count = await self._chat.redacted_since(sender_id, self._config.offender_window_seconds)
            if count < self._config.offender_threshold:
                return
            flag = await self._chat.raise_flag(sender_id, job_id, count)
            await self._session.commit()
        # The message is committed already. By class only: a database error's text can hold
        # SQL literals.
        except Exception as error:  # noqa: BLE001
            await self._session.rollback()
            logger.error(
                "chat_offender_check_failed",
                extra={
                    "user_id": str(sender_id),
                    "job_id": str(job_id),
                    "error": type(error).__name__,
                },
            )
            return
        extra = {
            "user_id": str(sender_id),
            "job_id": str(job_id),
            "flag_id": str(flag.flag_id),
            "window_count": count,
        }
        if flag.created:
            logger.error("chat_offender_flagged", extra=extra)
        else:
            logger.info("chat_offender_flag_raised", extra=extra)

    async def mark_read(self, user: UserAccount, job_id: uuid.UUID, up_to: uuid.UUID) -> int:
        """Moves the caller's marker to `up_to` when it is newer; the unread count after."""
        await self._participant(user, job_id)
        message = await self._chat.get_in_job(job_id, up_to)
        if message is None:
            raise InvalidMessageError
        await self._chat.move_read(job_id, user.id, message)
        await self._session.commit()
        return (await self._unread.unread_counts([job_id], user.id))[job_id]

    async def staff_messages(
        self, staff: UserAccount, job_id: uuid.UUID, *, limit: int | None, cursor: str | None
    ) -> StaffChatPage:
        """The thread for the BDC and admins, with every message's receipt: read-only, no
        marker moves."""
        before = _decode_cursor(cursor) if cursor else None
        parties = await self._jobs.parties(job_id)
        if parties is None:
            raise NotFoundError
        page, next_cursor = await self._page(parties, limit, before)
        now = await self._chat.now()
        originals = {
            message.id: original
            for message in (row.message for row in page)
            if (original := self._original(message, now, staff.id)) is not None
        }
        if originals:
            # Committed before the answer: an audit write that fails answers 500, so nothing is
            # shown unaudited.
            await AuditService(self._session).record_read(
                staff.id,
                AuditAction.JOB_CHAT_ORIGINALS_READ,
                AuditEntity(AuditEntityType.JOB, job_id),
                {
                    "originals": len(originals),
                    "message_ids": ",".join(str(message_id) for message_id in originals),
                },
            )
            await self._session.commit()
        logger.info(
            "job_chat_read_by_staff",
            extra={
                "job_id": str(job_id),
                "staff_id": str(staff.id),
                "count": len(page),
                "originals": len(originals),
            },
        )
        return StaffChatPage(
            items=[
                StaffChatMessageOut(
                    id=row.message.id,
                    sender=_side(row.message, parties, viewer=None),
                    body=row.message.body,
                    redacted=row.message.redacted,
                    original=originals.get(row.message.id),
                    created_at=row.message.created_at,
                    receipt=row.receipt,
                )
                for row in page
            ],
            next_cursor=next_cursor,
        )

    def _original(self, message: JobMessage, now: datetime, staff_id: uuid.UUID) -> str | None:
        """The message's original while it is kept and not expired; None otherwise. One that
        does not open (no key configured, an unknown key id, altered bytes) is None and an
        ERROR with ids only."""
        if (
            message.original_ciphertext is None
            or message.original_key_id is None
            or message.original_expires_at is None
            or message.original_expires_at <= now
        ):
            return None
        cipher = self._config.original_cipher
        try:
            if cipher is None:
                raise DecryptionError
            return cipher.decrypt(
                Sealed(message.original_key_id, message.original_ciphertext),
                original_associated_data(message.id),
            )
        except DecryptionError:
            logger.error(
                "chat_original_unreadable",
                extra={
                    "job_id": str(message.job_id),
                    "message_id": str(message.id),
                    "key_id": message.original_key_id,
                    "staff_id": str(staff_id),
                    "key_configured": cipher is not None,
                },
            )
            return None

    async def offender_flags(
        self, *, open_only: bool, limit: int | None, cursor: str | None
    ) -> ChatOffenderFlagPage:
        """Repeat-offender flags for the BDC, newest first: ids, counts and timestamps."""
        before = _decode_cursor(cursor) if cursor else None
        size = min(limit or self._config.list_default_limit, self._config.list_max_limit)
        rows = await self._chat.flags(open_only=open_only, limit=size + 1, before=before)
        page, more = rows[:size], len(rows) > size
        return ChatOffenderFlagPage(
            items=[
                ChatOffenderFlagOut(
                    id=flag.id,
                    user_id=flag.user_id,
                    job_id=flag.job_id,
                    window_count=flag.window_count,
                    created_at=flag.created_at,
                    updated_at=flag.updated_at,
                    resolved_at=flag.resolved_at,
                )
                for flag in page
            ],
            next_cursor=_encode_cursor(page[-1]) if more and page else None,
        )

    async def _participant(self, user: UserAccount, job_id: uuid.UUID) -> JobParties:
        parties = await self._jobs.parties(job_id)
        if parties is None or not parties.includes(user.id):
            raise NotFoundError
        return parties

    async def _page(
        self, parties: JobParties, limit: int | None, before: tuple[datetime, uuid.UUID] | None
    ) -> tuple[Sequence[MessageRow], str | None]:
        """`limit` above the maximum is capped, not refused."""
        size = min(limit or self._config.list_default_limit, self._config.list_max_limit)
        rows = await self._chat.page(
            parties.job_id, (parties.customer_id, parties.pro_user_id), size + 1, before
        )
        page, more = rows[:size], len(rows) > size
        return page, _encode_cursor(page[-1].message) if more and page else None


def _side(message: JobMessage, parties: JobParties, *, viewer: uuid.UUID | None) -> Sender:
    if viewer is not None and message.sender_id == viewer:
        return Sender.ME
    return Sender.CUSTOMER if message.sender_id == parties.customer_id else Sender.PRO


def _encode_cursor(row: JobMessage | ChatOffenderFlag) -> str:
    raw = f"{row.created_at.isoformat()}|{row.id}".encode()
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
