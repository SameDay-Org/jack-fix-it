"""The worker's part of an account deletion (#97): what could not be done in the transaction.

The deletion commits the anonymisation and one account_deletions row. Then, outside any
transaction, an attempt:
- once ACCOUNT_DELETION_SETTLE_SECONDS have passed, erases the account once more in a
  transaction of its own (accounts.eraser): a request the account sent before the deletion may
  have written after its commit (a name, a phone, a device, a request). The files and the
  Stripe Customer that pass finds join the work below, and the files' pass is always opened
  again: an upload URL issued before the deletion may have stored a file that no row names;
- detaches every card on the account's Stripe Customer (payment_methods.erasure), so none
  can be charged again;
- deletes the account's files from storage: the keys the erasures collected (originals and
  safe copies of the rows that went), and every other upload under the account's own prefix
  (u/<user id>/: a replaced ID photo, a removed draft's photo), but the job and dispute
  photos, whose records stay. Their rows are gone already, so nothing serves them meanwhile.

An attempt is claimed first (AccountDeletionRepository.claim, committed before any call), so a
task and a sweep never run one account at once. A part done stays done; a part that failed
waits ACCOUNT_DELETION_RETRY_AFTER_MINUTES for the sweep (accounts.tasks). A pass over the
files counts as the last one only after storage_settled_after: an upload URL issued before the
deletion (UPLOAD_URL_TTL_SECONDS) or a media copy running at it (or found running by the second
erasure) may still upload until then, and a pass before it is repeated. So the last pass comes
after all three: the URL's lifetime, any copy, and the second erasure.

Never raises to the task but what the second erasure's transaction raises (the task logs it
by class): returns an outcome. Logs carry the user id, counts and an error class only, never a
key (a key names the user and the file).
"""

import asyncio
import logging
import uuid
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.storage import Storage, StorageUnavailableError
from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_payment_methods import StripePaymentMethods
from app.modules.accounts.eraser import AccountEraser
from app.modules.accounts.models import AccountDeletion
from app.modules.accounts.repository import AccountDeletionRepository
from app.modules.payment_methods.erasure import detach_all_cards
from app.modules.uploads.schemas import UploadPurpose
from app.modules.users.service import UserService

logger = logging.getLogger(__name__)

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]
# Uploads kept with their records: the job's photos (the pro's work) and a dispute's evidence.
KEPT_PURPOSES: Final = frozenset({UploadPurpose.JOB_PHOTO.value, UploadPurpose.DISPUTE_PHOTO.value})


class CleanupOutcome(StrEnum):
    DONE = "done"  # erased again, the cards and the files: nothing left
    PARTIAL = "partial"  # something is left for a later attempt
    NOT_DUE = "not_due"  # done already, or another attempt holds it


class AccountCleanup:
    def __init__(
        self,
        sessions: SessionFactory,
        storage: Storage | None,
        methods: StripePaymentMethods | None,
        retry_after: timedelta,
        copy_settle: timedelta,
    ) -> None:
        self._sessions = sessions
        self._storage = storage
        self._methods = methods
        self._retry_after = retry_after
        # How long a media copy the second erasure finds running may still upload
        # (MEDIA_SANITIZE_JOB_TIMEOUT_SECONDS, as at the deletion).
        self._copy_settle = copy_settle

    async def due(self, limit: int) -> list[uuid.UUID]:
        async with self._sessions() as session:
            return await AccountDeletionRepository(session).due(self._retry_after, limit)

    async def run(self, user_id: uuid.UUID) -> CleanupOutcome:
        """One attempt at the user's cleanup (see the module doc)."""
        async with self._sessions() as session:
            row = await AccountDeletionRepository(session).claim(user_id, self._retry_after)
            await session.commit()
        if row is None:
            return CleanupOutcome.NOT_DUE
        if row.erased_again_at is None and datetime.now(UTC) >= row.erase_settled_after:
            row = await self._erase_again(user_id)
        async with self._sessions() as session:
            customer_id = await UserService(session).stripe_customer_id(user_id)
        errors: list[str] = []
        cards_done = row.cards_detached_at is not None or await self._detach(customer_id, errors)
        storage_done = row.storage_deleted_at is not None or await self._delete_files(
            user_id, row.storage_keys, row.storage_settled_after, errors
        )
        async with self._sessions() as session:
            await AccountDeletionRepository(session).record(
                user_id,
                cards_detached=cards_done,
                storage_deleted=storage_done,
                error=errors[0] if errors else None,
            )
            await session.commit()
        erased_again = row.erased_again_at is not None
        done = cards_done and storage_done and erased_again
        outcome = CleanupOutcome.DONE if done else CleanupOutcome.PARTIAL
        logger.info(
            "account_cleanup_ran",
            extra={
                "user_id": str(user_id),
                "outcome": outcome.value,
                "erased_again": erased_again,
                "cards_detached": cards_done,
                "files_deleted": storage_done,
                "errors": errors,
            },
        )
        return outcome

    async def _erase_again(self, user_id: uuid.UUID) -> AccountDeletion:
        """The second erasure, in a transaction of its own, under the same locks as the
        deletion's (the requests, then the user's row). It erases the row as read under the
        lock: its photo, email and phone are what a late write left."""
        async with self._sessions() as session:
            users = UserService(session)
            account = await users.get_by_id(user_id)
            if account is None:  # pragma: no cover - a deleted account's row never goes
                raise LookupError("deleted account not found")
            eraser = AccountEraser(session, users)
            held = await eraser.hold(account)
            locked = await users.get_for_update(user_id)
            if locked is None:  # pragma: no cover - a deleted account's row never goes
                raise LookupError("deleted account not found")
            erased = await eraser.erase(locked.account, held)
            now = datetime.now(UTC)
            row = await AccountDeletionRepository(session).record_second_pass(
                user_id,
                keys=erased.keys,
                has_stripe_customer=erased.has_stripe_customer,
                files_settled_after=now + self._copy_settle if erased.copy_in_flight else now,
            )
            await session.commit()
        logger.info(
            "account_erased_again", extra={"user_id": str(user_id), "counts": erased.counts}
        )
        return row

    async def _detach(self, customer_id: str | None, errors: list[str]) -> bool:
        if customer_id is None:
            return True
        if self._methods is None:
            errors.append("stripe_not_configured")
            return False
        try:
            await detach_all_cards(self._methods, customer_id)
        except (StripeUnavailableError, StripeRejectedError) as error:
            errors.append(type(error).__name__)
            return False
        return True

    async def _delete_files(
        self, user_id: uuid.UUID, keys: list[str], settled_after: datetime, errors: list[str]
    ) -> bool:
        if self._storage is None:
            errors.append("storage_not_configured")
            return False
        storage = self._storage
        # Read before the pass: a pass that started before the time is never the last.
        final = datetime.now(UTC) >= settled_after

        def own_uploads() -> list[str]:
            # Everything listed now, whatever its age.
            before = datetime.now(UTC) + timedelta(days=1)
            return [
                stored.key
                for page in storage.list_older_than(f"u/{user_id}/", before)
                for stored in page.objects
                if _purpose(stored.key) not in KEPT_PURPOSES
            ]

        try:
            listed = await asyncio.to_thread(own_uploads)
            everything = sorted({*keys, *listed})
            if everything:
                result = await asyncio.to_thread(storage.delete_many, everything)
                if result.failed:
                    errors.append("storage_delete_failed")
                    return False
        except StorageUnavailableError as error:
            errors.append(type(error).__name__)
            return False
        return final


def _purpose(key: str) -> str | None:
    """The upload purpose a key names (u/<user id>/<purpose>/<file>); None for another shape."""
    parts = key.split("/")
    return parts[2] if len(parts) > 3 else None
