import uuid
from datetime import datetime
from typing import Final

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin

# The longest message body, in characters, as stored (after cleaning and redaction).
MESSAGE_MAX_LENGTH: Final = 2000


class JobMessage(IdTimestampsMixin, Base):
    """One text message in a job's chat (D14.1, #71). Append-only: never edited or deleted.

    `body` is the text as stored and shown, already redacted (app.redaction) when it was
    written: the original is never kept in this part (#72 decides retention for disputes).
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
    )

    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id"))
    sender_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    body: Mapped[str] = mapped_column(Text)
    # True when the redactor masked at least one contact detail in what the sender typed.
    redacted: Mapped[bool]


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
