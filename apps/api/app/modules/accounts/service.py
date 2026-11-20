"""The account holder deletes their own account (#97): anonymised in place, in one transaction.

Apple requires the deletion inside the app. The users row cannot go (jobs, payments, reviews
and the audit log point at it), so the account is anonymised where it is:

- Confirmed with the current password, rate-limited per user (the route). Staff accounts are
  managed by script and refused.
- Refused (409, a code per reason) while something is in flight: a job not done (or, for a
  pro, its payout still owed), an open dispute, a refund not back on the card, a payment still
  being made, a transfer not made, a pro's live quote (accounts.errors). A customer's requests
  still open are cancelled instead: nothing was paid.
- Then every module erases its part (each module's erasure.py): what the person typed is
  replaced (requests, support tickets, staff notes about them), the address book, the devices,
  the waitlist entries and the chat originals go, the request addresses lose their street and
  point, the pro profile its bio, photo, areas and documents; the files' rows go at once.
- The account itself: email and password made unusable, phone, names, home and photo gone,
  a new card code, status deleted (UserService.anonymise). Every session is revoked, so its
  access tokens are refused at the next request (#161). The email is free for a new account.
- Kept untouched: jobs, payments, transfers, refunds, cancellations, disputes, reviews,
  quotes and the audit log. They name the account's id, and every name shows "Deleted user".
- One audit row (ids and counts only), and one account_deletions row: after the commit the
  worker detaches the cards in Stripe and deletes the files (accounts.cleanup).

The user's row is locked from the password check to the commit: a second deletion waits, then
finds the account deleted and answers the same. Logs carry ids, the role and counts only.
"""

import asyncio
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.accounts.errors import (
    ActiveJobError,
    ActiveQuoteError,
    InvalidPasswordError,
    OpenDisputeError,
    PaymentInProgressError,
    PayoutPendingError,
    RefundPendingError,
    StaffAccountDeletionError,
)
from app.modules.accounts.repository import AccountDeletionRepository
from app.modules.accounts.tasks import enqueue_account_cleanup
from app.modules.addresses.erasure import AddressErasure
from app.modules.audit.service import AuditService
from app.modules.audit.types import AuditAction, AuditEntity, AuditEntityType
from app.modules.auth import security
from app.modules.auth.service import AuthService
from app.modules.chat.erasure import forget_originals
from app.modules.devices.erasure import forget_devices
from app.modules.disputes.erasure import has_open_dispute
from app.modules.jobs.erasure import JobErasure
from app.modules.ops.erasure import erase_notes
from app.modules.payments.erasure import (
    customer_has_open_payment,
    has_unsettled_refund,
    pro_has_unsettled_transfer,
)
from app.modules.pros.erasure import ProErasure
from app.modules.pros.service import ProService
from app.modules.quotes.erasure import pro_has_live_quote
from app.modules.requests.erasure import RequestErasure
from app.modules.support.erasure import erase_messages
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount, UserRole, UserStatus
from app.modules.waitlist.erasure import forget_entries
from app.queue import JobQueue

logger = logging.getLogger(__name__)

STAFF: Final = frozenset({UserRole.AGENT, UserRole.ADMIN})


@dataclass(frozen=True)
class AccountDeletionConfig:
    # How long a media copy that was running at the deletion may still upload: the files'
    # last pass waits for it (MEDIA_SANITIZE_JOB_TIMEOUT_SECONDS).
    copy_settle_seconds: int
    enqueue_timeout_seconds: float

    @classmethod
    def from_settings(cls, settings: Settings) -> "AccountDeletionConfig":
        return cls(
            copy_settle_seconds=settings.media_sanitize_job_timeout_seconds,
            enqueue_timeout_seconds=settings.job_enqueue_timeout_seconds,
        )


class AccountDeletionService:
    def __init__(
        self,
        session: AsyncSession,
        users: UserService,
        auth: AuthService,
        config: AccountDeletionConfig,
        queue: JobQueue,
    ) -> None:
        self._session = session
        self._users = users
        self._auth = auth
        self._config = config
        self._queue = queue
        self._jobs = JobErasure(session)

    async def delete(self, account: UserAccount, password: str) -> None:
        """Deletes the caller's account and commits (see the module doc). Idempotent: a
        deletion that waited for another one of the same account answers the same."""
        if account.role in STAFF:
            raise StaffAccountDeletionError
        locked = await self._users.get_for_update(account.id)
        if locked is None or locked.account.status is UserStatus.DELETED:
            return
        if not await asyncio.to_thread(security.verify_password, locked.password_hash, password):
            logger.info(
                "account_delete_refused",
                extra={"user_id": str(account.id), "reason": "invalid_password"},
            )
            raise InvalidPasswordError
        user = locked.account
        pro_id = (
            await ProService(self._session).get_profile_id_for_user(user.id)
            if user.role is UserRole.PRO
            else None
        )
        await self._refuse_while_busy(user, pro_id)

        counts: dict[str, int] = {}
        keys: list[str] = []
        copy_in_flight = False
        if user.role is UserRole.CUSTOMER:
            # The transitions first: each drains the unit of work before it writes.
            requests = RequestErasure(self._session)
            counts["requests_cancelled"] = await requests.cancel_open(user)
            media = await requests.erase(user.id)
            keys.extend(media.keys)
            copy_in_flight = media.copy_in_flight
            addresses = await AddressErasure(self._session).erase(user.id)
            counts["saved_addresses"] = addresses.saved_deleted
            counts["request_addresses"] = addresses.request_addresses_erased
            counts["check_in_points"] = await self._jobs.forget_check_in_points(user.id)
            notes = await erase_notes(self._session, requests.customer_request_ids(user.id))
            counts["staff_notes"] = notes.notes
            counts["staff_followups"] = notes.followups
        else:
            keys.extend(await ProErasure(self._session).erase(user.id))
        if user.photo_key is not None:
            keys.append(user.photo_key)
        counts["devices"] = await forget_devices(self._session, user.id)
        counts["waitlist_entries"] = await forget_entries(
            self._session, user.id, user.email, user.phone
        )
        counts["support_messages"] = await erase_messages(self._session, user.id)
        counts["chat_originals"] = await forget_originals(self._session, user.id)
        customer_id = await self._users.stripe_customer_id(user.id)
        await self._auth.revoke_all_sessions(user.id)
        await self._users.anonymise(user.id)

        now = datetime.now(UTC)
        files = sorted(set(keys))
        settle = timedelta(seconds=self._config.copy_settle_seconds if copy_in_flight else 0)
        await AccountDeletionRepository(self._session).add(
            user.id,
            storage_keys=files,
            storage_settled_after=now + settle,
            # Nothing to detach without a Stripe Customer.
            cards_detached_at=now if customer_id is None else None,
        )
        counts["files"] = len(files)
        await AuditService(self._session).record_party_action(
            user.id,
            AuditAction.ACCOUNT_DELETE,
            AuditEntity(AuditEntityType.USER, user.id),
            {"role": user.role.value, "status": user.status.value},
            {"status": UserStatus.DELETED.value, **counts},
        )
        await self._session.commit()
        logger.info(
            "account_deleted",
            extra={"user_id": str(user.id), "role": user.role.value, "counts": counts},
        )
        await enqueue_account_cleanup(self._queue, user.id, self._config.enqueue_timeout_seconds)

    async def _refuse_while_busy(self, user: UserAccount, pro_id: uuid.UUID | None) -> None:
        """Raises the first reason the account cannot go yet (accounts.errors)."""
        if user.role is UserRole.CUSTOMER:
            jobs = self._jobs.customer_job_ids(user.id)
            if await self._jobs.customer_has_job_in_flight(user.id):
                raise ActiveJobError
            if await has_open_dispute(self._session, jobs):
                raise OpenDisputeError
            if await has_unsettled_refund(self._session, jobs):
                raise RefundPendingError
            if await customer_has_open_payment(self._session, user.id):
                raise PaymentInProgressError
            return
        if pro_id is None:
            return
        if await self._jobs.pro_has_job_in_flight(pro_id):
            raise ActiveJobError
        if await has_open_dispute(self._session, self._jobs.pro_job_ids(pro_id)):
            raise OpenDisputeError
        if await pro_has_unsettled_transfer(self._session, pro_id):
            raise PayoutPendingError
        if await pro_has_live_quote(self._session, pro_id, self._jobs.quote_ids_with_a_job()):
            raise ActiveQuoteError
