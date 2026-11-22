from datetime import datetime
from enum import StrEnum
from typing import Final

from sqlalchemy import CheckConstraint, DateTime, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum

# The longest consent version id (the web's, e.g. "interest-2026-11-19").
CONSENT_VERSION_MAX_LENGTH: Final = 64


class InterestSource(StrEnum):
    SHOWCASE = "showcase"


class LaunchInterest(IdTimestampsMixin, Base):
    """Someone who asked to hear when the app is in the stores (#409): an email only, one row
    per email (normalised: trimmed, lower case), with the consent they gave: the version of the
    words they saw and when. Never notified from here; a staff export comes later."""

    __tablename__ = "launch_interest"
    __table_args__ = (
        UniqueConstraint("email"),
        CheckConstraint("email = lower(email)", name="email_lowercase"),
    )

    email: Mapped[str] = mapped_column(String(320))
    locale: Mapped[str] = mapped_column(String(8), server_default="en")
    source: Mapped[InterestSource] = mapped_column(str_enum(InterestSource, "interest_source"))
    consent_version: Mapped[str] = mapped_column(String(CONSENT_VERSION_MAX_LENGTH))
    consented_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
