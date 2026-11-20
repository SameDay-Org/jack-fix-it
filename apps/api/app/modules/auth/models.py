import uuid
from datetime import datetime

from sqlalchemy import CHAR, DateTime, ForeignKey, Index, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin


class RefreshToken(IdTimestampsMixin, Base):
    """One issued refresh token. The raw value is never stored, only its SHA-256 hex digest.

    A family is every token rotated from one login or registration; rotation and reuse
    detection (#116) revoke a whole family.
    """

    __tablename__ = "refresh_tokens"
    __table_args__ = (
        # Every authenticated request asks whether its access token's family is still live
        # (#161): one entry per live family, however many rotations the family has made.
        Index(
            "ix_refresh_tokens_live_family_id",
            "family_id",
            postgresql_where=text("revoked_at IS NULL"),
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    family_id: Mapped[uuid.UUID] = mapped_column(index=True)
    token_hash: Mapped[str] = mapped_column(CHAR(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The token this one was rotated into (#116).
    replaced_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("refresh_tokens.id"), index=True
    )
