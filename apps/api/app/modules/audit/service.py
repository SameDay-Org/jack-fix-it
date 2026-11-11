"""The audit log of staff actions on money (#58, Vault round 1 B2; docs/mvp-plan.md).

Every staff override of a payment or payout account (scripts/resolve_payment_intent.py,
scripts/resolve_payout_account.py) names its operator, an active admin, and writes one row
here in the same transaction as the change: `record` checks the operator again, inserts and
flushes the row, and the caller commits both. An audit write that fails, or an operator who is
no longer an active admin, rolls the change back. A refusal or a dry run writes nothing. Rows
are append-only (a trigger refuses UPDATE, DELETE and TRUNCATE).

Staff reads of what only staff may see are audited too (#72: the originals of redacted chat
messages): `record_read` writes the row of a read by an active agent or admin, and the caller
commits it before answering, so nothing is shown unaudited.

Staff actions that are not about money and that the BDC takes too (#274: a support ticket's
status) go through `record_staff_action`: the actor is an active agent or admin, checked
again here, and the row is flushed in the caller's transaction, as for `record`.

before and after carry ids, statuses, Stripe object ids and ISO timestamps only: never PII
(names, emails, phones, addresses) or secrets.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.repository import AuditRepository
from app.modules.audit.types import (
    ActorNotStaffError,
    AuditAction,
    AuditEntity,
    AuditState,
    Operator,
    OperatorNotAdminError,
    ReaderNotStaffError,
)
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount, UserRole, UserStatus


def _active_staff(account: UserAccount | None) -> bool:
    return (
        account is not None
        and account.role in (UserRole.AGENT, UserRole.ADMIN)
        and account.status == UserStatus.ACTIVE
    )


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

    async def record_staff_action(
        self,
        actor_id: uuid.UUID,
        action: AuditAction,
        entity: AuditEntity,
        before: AuditState,
        after: AuditState,
    ) -> None:
        """Adds the row of an action any staff member may take (the BDC's agents included) to
        the caller's transaction and flushes it, so a failure surfaces before the caller
        commits the change it describes. ActorNotStaffError when the actor is not an active
        agent or admin (demoted or suspended since the route's check). Money overrides never
        come through here: `record` takes an admin only."""
        if not _active_staff(await self._users.get_by_id(actor_id)):
            raise ActorNotStaffError
        await self._audit.add(
            actor_user_id=actor_id,
            action=action.value,
            entity_type=entity.type.value,
            entity_id=entity.id,
            before=before,
            after=after,
            reason=None,
        )

    async def record_read(
        self, reader_id: uuid.UUID, action: AuditAction, entity: AuditEntity, read: AuditState
    ) -> None:
        """Adds the row of a staff read to the caller's transaction and flushes it; `read`
        says what was shown (ids and counts). ReaderNotStaffError when the reader is not an
        active agent or admin."""
        if not _active_staff(await self._users.get_by_id(reader_id)):
            raise ReaderNotStaffError
        await self._audit.add(
            actor_user_id=reader_id,
            action=action.value,
            entity_type=entity.type.value,
            entity_id=entity.id,
            before={},
            after=read,
            reason=None,
        )
