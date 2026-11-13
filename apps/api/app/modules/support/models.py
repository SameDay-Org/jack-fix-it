import uuid
from datetime import datetime
from enum import StrEnum
from typing import Final

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum

# The longest ticket message, in characters, as stored (trimmed).
MESSAGE_MAX_LENGTH: Final = 2000
# The longest app version the app may report, e.g. "1.4.0 (52)".
APP_VERSION_MAX_LENGTH: Final = 32


class TicketTopic(StrEnum):
    """What the ticket is about, as the user picked it in the app."""

    ACCOUNT = "account"
    PAYMENT = "payment"
    JOB = "job"
    SAFETY = "safety"
    APP_PROBLEM = "app_problem"
    OTHER = "other"


class TicketStatus(StrEnum):
    OPEN = "open"  # nobody on the team took it yet
    IN_PROGRESS = "in_progress"  # someone on the team is on it
    CLOSED = "closed"  # answered or settled; staff may reopen it


class TicketRole(StrEnum):
    """Who wrote the ticket, as they were when they wrote it: the app's users only (agents and
    admins use the panel and write no tickets)."""

    CUSTOMER = "customer"
    PRO = "pro"


class TicketPlatform(StrEnum):
    """The device the ticket was written on, as the app reports it."""

    IOS = "ios"
    ANDROID = "android"


class SupportTicket(IdTimestampsMixin, Base):
    """One message from a customer or a pro to the team ("Talk to Jack", #274).

    `message` is stored as typed, not redacted: only staff read it, and the user may need to
    give a phone or an email to be reached. PII: never logged, never shown to another user.
    `role` is the writer's role when the ticket was written (a later role change does not
    rewrite it). `job_id` is a job the writer takes part in, when the ticket is about one.
    `status` changes only by a staff action, audited (audit_log); `closed_at` is set while the
    ticket is closed and cleared when staff reopen it.
    """

    __tablename__ = "support_tickets"
    __table_args__ = (
        CheckConstraint(
            f"char_length(message) BETWEEN 1 AND {MESSAGE_MAX_LENGTH}", name="message_length"
        ),
        CheckConstraint("message ~ '[^[:space:]]'", name="message_not_blank"),
        CheckConstraint(
            "(status = 'closed') = (closed_at IS NOT NULL)", name="closed_at_matches_status"
        ),
        CheckConstraint(
            f"char_length(app_version) BETWEEN 1 AND {APP_VERSION_MAX_LENGTH}",
            name="app_version_length",
        ),
        # The writer's own list, newest first; also serves the user_id foreign key.
        Index("ix_support_tickets_user_id_created_at", "user_id", "created_at", "id"),
        # The staff list, newest first: one status, or all of them.
        Index("ix_support_tickets_status_created_at", "status", "created_at", "id"),
        Index("ix_support_tickets_created_at", "created_at", "id"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    role: Mapped[TicketRole] = mapped_column(str_enum(TicketRole, "role"))
    topic: Mapped[TicketTopic] = mapped_column(str_enum(TicketTopic, "topic"))
    message: Mapped[str] = mapped_column(Text)
    job_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("jobs.id"), index=True)
    status: Mapped[TicketStatus] = mapped_column(
        str_enum(TicketStatus, "status"), server_default=TicketStatus.OPEN.value
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    app_version: Mapped[str | None] = mapped_column(String(APP_VERSION_MAX_LENGTH))
    platform: Mapped[TicketPlatform | None] = mapped_column(str_enum(TicketPlatform, "platform"))
