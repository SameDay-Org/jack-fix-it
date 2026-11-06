import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.models import AuditLog
from app.modules.audit.types import AuditState


class AuditRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(
        self,
        *,
        actor_user_id: uuid.UUID,
        action: str,
        entity_type: str,
        entity_id: uuid.UUID,
        before: AuditState,
        after: AuditState,
        reason: str | None,
    ) -> None:
        """Inserts the row now (flush), so a failure surfaces before the caller commits."""
        self._session.add(
            AuditLog(
                actor_user_id=actor_user_id,
                action=action,
                entity_type=entity_type,
                entity_id=entity_id,
                before=dict(before),
                after=dict(after),
                reason=reason,
            )
        )
        await self._session.flush()
