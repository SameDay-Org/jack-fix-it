import uuid
from datetime import datetime

from pydantic import JsonValue
from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Setting(Base):
    """One runtime setting: a JSON value under a stable key (D9.1, #48). The migrations seed
    the launch values; the admin (#41) edits them, and every read takes the current row."""

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[JsonValue] = mapped_column(JSONB, nullable=False)
    # The staff member who last changed it; NULL for a seeded value.
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
