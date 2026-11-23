import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum
from app.modules.terms.types import TermsKind

# A version id as the settings take it (app.config.TERMS_VERSION_PATTERN).
VERSION_MAX_LENGTH = 64


class TermsAcceptance(IdTimestampsMixin, Base):
    """An account accepted one version of one legal document (#97). The text itself is not in
    the API: the version id names it. One row per account, kind and version: accepting again
    keeps the first time. Ids, the kind, the version and the time only."""

    __tablename__ = "terms_acceptances"
    __table_args__ = (
        UniqueConstraint("user_id", "kind", "version"),
        CheckConstraint(
            f"version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{{0,{VERSION_MAX_LENGTH - 1}}}$'",
            name="version_id",
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[TermsKind] = mapped_column(str_enum(TermsKind, "terms_kind"))
    version: Mapped[str] = mapped_column(String(VERSION_MAX_LENGTH))
    # The database's clock, at the first acceptance of this version.
    accepted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
