import uuid
from datetime import datetime
from enum import StrEnum
from typing import Final

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.crypto import KEY_ID_MAX_LENGTH, NONCE_BYTES, TAG_BYTES
from app.db import Base, IdTimestampsMixin

# The longest message body, in characters, as stored (after cleaning and redaction).
MESSAGE_MAX_LENGTH: Final = 2000


class Receipt(StrEnum):
    """How far a message got with its recipient, the participant who did not send it: sent,
    delivered (their app fetched it) or seen (they marked it read). From the recipient's read
    marker and deliveries (#331)."""

    SENT = "sent"  # stored; the recipient's app has not fetched it yet
    DELIVERED = "delivered"  # a listing returned it to the recipient (job_message_deliveries)
    SEEN = "seen"  # the recipient marked it read (their read marker)


class JobMessage(IdTimestampsMixin, Base):
    """One text message in a job's chat (D14.1, #71). Append-only: never edited or deleted.

    `body` is the text as stored and shown, already redacted (app.redaction) when it was
    written. When something was masked, the original as typed is kept for staff only (#72):
    encrypted (app.crypto; the message id is its associated data), with the id of its key, and
    cleared by the worker once `original_expires_at` passes. Without a configured key no
    original is kept. The three original_* columns are set or cleared together.
    `created_at` is set by the service under the job's lock, so messages of a job are ordered
    by (created_at, id) in the order they committed.
    """

    __tablename__ = "job_messages"
    __table_args__ = (
        CheckConstraint(
            f"char_length(body) BETWEEN 1 AND {MESSAGE_MAX_LENGTH}", name="body_length"
        ),
        CheckConstraint("body ~ '[^[:space:]]'", name="body_not_blank"),
        # The thread, newest first, and the unread counts: both walk (created_at, id) in a job.
        Index("ix_job_messages_job_id_created_at", "job_id", "created_at", "id"),
        CheckConstraint(
            "(original_ciphertext IS NULL) = (original_key_id IS NULL) "
            "AND (original_key_id IS NULL) = (original_expires_at IS NULL)",
            name="original_complete",
        ),
        CheckConstraint("original_ciphertext IS NULL OR redacted", name="original_only_redacted"),
        CheckConstraint(
            f"octet_length(original_ciphertext) > {NONCE_BYTES + TAG_BYTES}",
            name="original_ciphertext_length",
        ),
        CheckConstraint(
            f"char_length(original_key_id) BETWEEN 1 AND {KEY_ID_MAX_LENGTH}",
            name="original_key_id_length",
        ),
        # The purge reads the originals due, oldest first; most rows have none.
        Index(
            "ix_job_messages_original_expires_at",
            "original_expires_at",
            postgresql_where=text("original_expires_at IS NOT NULL"),
        ),
    )

    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id"))
    sender_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    body: Mapped[str] = mapped_column(Text)
    # True when the redactor masked at least one contact detail in what the sender typed.
    redacted: Mapped[bool]
    # What the sender typed, sealed (app.crypto): nonce + ciphertext + tag. Staff only (#72).
    original_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    original_key_id: Mapped[str | None] = mapped_column(String(KEY_ID_MAX_LENGTH))
    original_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class JobChatRead(IdTimestampsMixin, Base):
    """How far one participant has read a job's chat: their read marker, moved forward only.

    `last_read_message_at` is the marked message's created_at, copied so the marker compares
    with messages by (created_at, id) without a join (messages are never edited)."""

    __tablename__ = "job_chat_reads"
    __table_args__ = (UniqueConstraint("job_id", "user_id"),)

    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    last_read_message_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("job_messages.id"), index=True
    )
    last_read_message_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class JobMessageDelivery(IdTimestampsMixin, Base):
    """One message delivered to its recipient: a listing returned it to their app (#331).
    Written once per (message, recipient), never moved or removed.

    Per message, not a marker: a page holds a slice of the thread (the newest, or an older one
    by cursor), so "everything up to the newest message returned" would claim messages the page
    skipped. Only what a page returned is delivered.

    A table of its own, not columns on job_chat_reads, so the API version still serving while
    the migration runs (which knows only job_chat_reads) keeps working. Reading implies
    delivered without writing here: a message at or behind the read marker is seen."""

    __tablename__ = "job_message_deliveries"
    __table_args__ = (UniqueConstraint("message_id", "user_id"),)

    message_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("job_messages.id"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)


class ChatOffenderFlag(IdTimestampsMixin, Base):
    """A sender whose messages were redacted CHAT_OFFENDER_THRESHOLD times, across all jobs,
    within CHAT_OFFENDER_WINDOW_DAYS (#72): listed for the BDC. At most one open flag per user
    (a partial unique index); a later redaction while it is open raises `window_count` to the
    count it saw, never lowers it. `job_id` is the job of the redaction that opened the flag.
    Ids and counts only: never message text. Resolving (`resolved_at`) is a later admin action.
    """

    __tablename__ = "chat_offender_flags"
    __table_args__ = (
        CheckConstraint("window_count >= 1", name="window_count_positive"),
        CheckConstraint(
            "resolved_at IS NULL OR resolved_at >= created_at", name="resolved_after_created"
        ),
        Index(
            "uq_chat_offender_flags_open_user_id",
            "user_id",
            unique=True,
            postgresql_where=text("resolved_at IS NULL"),
        ),
        # The staff list, newest first.
        Index("ix_chat_offender_flags_created_at", "created_at", "id"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id"), index=True)
    window_count: Mapped[int]
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
