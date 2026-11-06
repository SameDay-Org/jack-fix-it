"""The audit log of staff actions on money (#58, Vault round 1 B2; docs/mvp-plan.md).

Every staff override of a payment or payout account (scripts/resolve_payment_intent.py,
scripts/resolve_payout_account.py) names its operator, an active admin, and writes one row
here in the same transaction as the change: `record` checks the operator again, inserts and
flushes the row, and the caller commits both. An audit write that fails, or an operator who is
no longer an active admin, rolls the change back. A refusal or a dry run writes nothing. Rows
are append-only (a trigger refuses UPDATE, DELETE and TRUNCATE).

before and after carry ids, statuses, Stripe object ids and ISO timestamps only: never PII
(names, emails, phones, addresses) or secrets.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.repository import AuditRepository
from app.modules.audit.types import (
    AuditAction,
    AuditEntity,
    AuditState,
    Operator,
    OperatorNotAdminError,
)
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount, UserRole, UserStatus


def _active_admin(account: UserAccount | None) -> bool:
    return (
        account is not None
        and account.role == UserRole.ADMIN
        and account.status == UserStatus.ACTIVE
    )


class AuditService:
    def __init__(self, session: AsyncSession) -> None:
        self._audit = AuditRepository(session)
        self._users = UserService(session)

    async def admin_operator(self, email: str) -> uuid.UUID | None:
        """The user id of the active admin account with this email; None for anyone else
        (unknown, another role, suspended)."""
        account = await self._users.get_by_email(email.strip().lower())
        return account.id if account is not None and _active_admin(account) else None

    async def record(
        self,
        operator: Operator,
        action: AuditAction,
        entity: AuditEntity,
        before: AuditState,
        after: AuditState,
    ) -> None:
        """Adds the action's row to the caller's transaction and flushes it, so a failure
        surfaces before the caller commits the change it describes. OperatorNotAdminError when
        the operator is no longer an active admin (demoted or suspended since the check)."""
        if not _active_admin(await self._users.get_by_id(operator.user_id)):
            raise OperatorNotAdminError
        await self._audit.add(
            actor_user_id=operator.user_id,
            action=action.value,
            entity_type=entity.type.value,
            entity_id=entity.id,
            before=before,
            after=after,
            reason=operator.reason,
        )
