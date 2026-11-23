import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin

# The cleanup still to do: storage objects not deleted, or cards not detached.
PENDING_CONDITION = (
    "storage_deleted_at IS NULL OR cards_detached_at IS NULL OR erased_again_at IS NULL"
)


class AccountDeletion(IdTimestampsMixin, Base):
    """What an account deletion (#97) leaves to the worker, once the anonymisation committed:
    the saved cards to detach in Stripe and the account's files to delete from storage. One
    row per deleted account, never removed. Ids, storage keys, times and an error class only.

    The rows that served the files are gone in the deletion itself, so nothing serves them
    meanwhile; this row is how the files are still found and deleted, however long the storage
    or Stripe stays unavailable (the worker's sweep, accounts.tasks)."""

    __tablename__ = "account_deletions"
    __table_args__ = (
        CheckConstraint("attempts >= 0", name="attempts_not_negative"),
        # The sweep reads what is still to do, least recently tried first.
        Index(
            "ix_account_deletions_pending",
            "last_attempt_at",
            postgresql_where=text(PENDING_CONDITION),
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), unique=True)
    # The storage keys to delete: originals (u/<user id>/...) and safe copies (m/...). Emptied
    # once they are deleted.
    storage_keys: Mapped[list[str]] = mapped_column(JSONB)
    # No pass over the keys counts as the last one before this time: a media copy that was
    # running when the account was deleted may still upload its safe copy until then.
    storage_settled_after: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    storage_deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Set at the deletion when the account has no Stripe Customer (no card to detach).
    cards_detached_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The worker erases the account once more after this time (accounts.eraser), when it did.
    erase_settled_after: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    erased_again_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(server_default=text("0"))
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The error class of the last failed attempt, never its message (it can carry ids).
    last_error: Mapped[str | None] = mapped_column(String(64))
