import uuid

from sqlalchemy import ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin
from app.modules.audit.types import AuditValue


class AuditLog(IdTimestampsMixin, Base):
    """One staff action on money (#58, Vault round 1 B2; AuditService.record), one staff read
    of what only staff may see (#72, AuditService.record_read), or one staff action the BDC
    takes too (#274: a support ticket's status; AuditService.record_staff_action).
    Append-only: a trigger refuses UPDATE, DELETE and TRUNCATE. before/after hold ids,
    statuses, Stripe object ids and timestamps: never PII or secrets."""

    __tablename__ = "audit_log"
    __table_args__ = (Index("ix_audit_log_entity", "entity_type", "entity_id"),)

    # The staff account that acted (an admin, or an agent where the action allows one): NOT
    # NULL, so no action is anonymous.
    actor_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    # What was done, as <entity>.<verb> (app.modules.audit.types.AuditAction).
    action: Mapped[str] = mapped_column(String(64))
    entity_type: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[uuid.UUID]
    before: Mapped[dict[str, AuditValue]] = mapped_column(JSONB)
    after: Mapped[dict[str, AuditValue]] = mapped_column(JSONB)
    # Why, as the operator typed it (optional); no PII by instruction (apps/api/AGENTS.md).
    reason: Mapped[str | None] = mapped_column(Text)
