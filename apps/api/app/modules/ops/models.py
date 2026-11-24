"""The BDC's own rows on a request (#82): internal notes and follow-ups. Staff only: nothing
here is ever shown to the customer or the pro."""

import uuid
from datetime import datetime
from typing import Final

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin

NOTE_MAX_LENGTH: Final = 2_000
FOLLOWUP_NOTE_MAX_LENGTH: Final = 500


class RequestNote(IdTimestampsMixin, Base):
    """A staff member's note on a request: plain text, kept as written (staff text: the chat
    redactor does not apply), appended only. Nothing changes or deletes one, but the deletion
    of the customer's account, which replaces its text (#97, ops.erasure)."""

    __tablename__ = "request_notes"
    __table_args__ = (
        CheckConstraint(f"char_length(body) BETWEEN 1 AND {NOTE_MAX_LENGTH}", name="body_length"),
        Index("ix_request_notes_request_id_created_at", "request_id", "created_at"),
    )

    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("service_requests.id"))
    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    body: Mapped[str] = mapped_column(Text)


class RequestFollowup(IdTimestampsMixin, Base):
    """Something a staff member is to do on a request by `due_at` (their own, or one an admin
    gave them); done once, by them or an admin."""

    __tablename__ = "request_followups"
    __table_args__ = (
        CheckConstraint(
            f"char_length(note) BETWEEN 1 AND {FOLLOWUP_NOTE_MAX_LENGTH}", name="note_length"
        ),
        CheckConstraint("(done_at IS NULL) = (done_by IS NULL)", name="done_by_whom"),
        # "Mine, due by the end of today": a staff member's open follow-ups by due time.
        Index(
            "ix_request_followups_open_assignee_due",
            "assigned_to",
            "due_at",
            "id",
            postgresql_where=text("done_at IS NULL"),
        ),
    )

    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("service_requests.id"), index=True)
    assigned_to: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    note: Mapped[str] = mapped_column(Text)
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    done_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
