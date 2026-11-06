"""Shared fixtures of the audit_log tests (#58, Vault round 1 B2): the staff scripts' operator
and the rows they write."""

import uuid
from dataclasses import dataclass
from typing import Final

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.models import AuditLog
from app.modules.audit.types import AuditValue
from app.modules.users.models import User
from app.modules.users.types import UserRole, UserStatus

# The admin every staff-script test runs as. Its domain is checked absent from all output.
OPERATOR_DOMAIN: Final = "@operator.example.invalid"
OPERATOR_EMAIL: Final = f"audit-admin{OPERATOR_DOMAIN}"


async def make_staff(
    session: AsyncSession,
    *,
    email: str = OPERATOR_EMAIL,
    role: UserRole = UserRole.ADMIN,
    status: UserStatus = UserStatus.ACTIVE,
) -> uuid.UUID:
    """A committed account (an active admin by default)."""
    user = User(email=email, password_hash="x", role=role, status=status)
    session.add(user)
    await session.commit()
    return user.id


@dataclass(frozen=True)
class AuditRow:
    actor_user_id: uuid.UUID
    action: str
    entity_type: str
    entity_id: uuid.UUID
    before: dict[str, AuditValue]
    after: dict[str, AuditValue]
    reason: str | None


async def audit_rows(session: AsyncSession) -> list[AuditRow]:
    """Every audit_log row, oldest first, as last committed."""
    rows = await session.scalars(
        select(AuditLog)
        .order_by(AuditLog.created_at, AuditLog.id)
        .execution_options(populate_existing=True)
    )
    return [
        AuditRow(
            actor_user_id=row.actor_user_id,
            action=row.action,
            entity_type=row.entity_type,
            entity_id=row.entity_id,
            before=row.before,
            after=row.after,
            reason=row.reason,
        )
        for row in rows
    ]
