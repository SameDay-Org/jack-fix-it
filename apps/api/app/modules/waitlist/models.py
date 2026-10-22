import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum


class WaitlistSource(StrEnum):
    APP = "app"
    WEB = "web"


class WaitlistEntry(IdTimestampsMixin, Base):
    """A contact who asked to hear when their ZIP is served. The contact is kept only for that
    notice (legal texts pending, #10): one entry per contact per ZIP."""

    __tablename__ = "waitlist_entries"
    __table_args__ = (
        CheckConstraint("email IS NOT NULL OR phone IS NOT NULL", name="email_or_phone"),
        CheckConstraint("email = lower(email)", name="email_lowercase"),
        Index(
            "uq_waitlist_entries_zip_code_email",
            "zip_code",
            "email",
            unique=True,
            postgresql_where=text("email IS NOT NULL"),
        ),
        Index(
            "uq_waitlist_entries_zip_code_phone",
            "zip_code",
            "phone",
            unique=True,
            postgresql_where=text("phone IS NOT NULL"),
        ),
    )

    zip_code: Mapped[str] = mapped_column(String(10), index=True)
    email: Mapped[str | None] = mapped_column(String(320))
    # E.164.
    phone: Mapped[str | None] = mapped_column(String(20))
    category_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("categories.id"), index=True)
    locale: Mapped[str] = mapped_column(String(8), server_default="en")
    source: Mapped[WaitlistSource] = mapped_column(str_enum(WaitlistSource, "waitlist_source"))
    # Set when the person was signed in.
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), index=True)
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
