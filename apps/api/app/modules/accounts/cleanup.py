"""The worker's part of an account deletion (#97): what could not be done in the transaction.

The deletion commits the anonymisation and one account_deletions row. Then, outside any
transaction, an attempt:
- detaches every card on the account's Stripe Customer (payment_methods.erasure), so none
  can be charged again;
- deletes the account's files from storage: its ID photo, a pro's profile photo and
  documents, a customer's request media (originals and safe copies). Their rows are gone
  already, so nothing serves them meanwhile.

An attempt is claimed first (AccountDeletionRepository.claim, committed before any call), so a
task and a sweep never run one account at once. A part done stays done; a part that failed
waits ACCOUNT_DELETION_RETRY_AFTER_MINUTES for the sweep (accounts.tasks). A pass over the
files counts as the last one only after storage_settled_after: a media copy running at the
deletion may still upload until then, and a pass before it is repeated.

Never raises to the task: returns an outcome. Logs carry the user id, counts and an error
class only, never a key (a key names the user and the file).
"""

import asyncio
import logging
import uuid
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from datetime import UTC, datetime, timedelta
from enum import StrEnum

from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.storage import Storage, StorageUnavailableError
from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_payment_methods import StripePaymentMethods
from app.modules.accounts.repository import AccountDeletionRepository
from app.modules.payment_methods.erasure import detach_all_cards
from app.modules.users.service import UserService

logger = logging.getLogger(__name__)

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


class CleanupOutcome(StrEnum):
    DONE = "done"  # the cards and the files: nothing left
    PARTIAL = "partial"  # something is left for a later attempt
    NOT_DUE = "not_due"  # done already, or another attempt holds it


class AccountCleanup:
    def __init__(
        self,
        sessions: SessionFactory,
        storage: Storage | None,
        methods: StripePaymentMethods | None,
        retry_after: timedelta,
    ) -> None:
        self._sessions = sessions
        self._storage = storage
        self._methods = methods
        self._retry_after = retry_after

    async def due(self, limit: int) -> list[uuid.UUID]:
        async with self._sessions() as session:
            return await AccountDeletionRepository(session).due(self._retry_after, limit)

    async def run(self, user_id: uuid.UUID) -> CleanupOutcome:
        """One attempt at the user's cleanup (see the module doc)."""
        async with self._sessions() as session:
            claimed = await AccountDeletionRepository(session).claim(user_id, self._retry_after)
            customer_id = await UserService(session).stripe_customer_id(user_id)
            await session.commit()
        if claimed is None:
            return CleanupOutcome.NOT_DUE
        errors: list[str] = []
        cards_done = claimed.cards_detached_at is not None
        if not cards_done:
            cards_done = await self._detach(user_id, customer_id, errors)
        storage_done = claimed.storage_deleted_at is not None
        if not storage_done:
            storage_done = await self._delete_files(
                user_id, claimed.storage_keys, claimed.storage_settled_after, errors
            )
        async with self._sessions() as session:
            await AccountDeletionRepository(session).record(
                user_id,
                cards_detached=cards_done,
                storage_deleted=storage_done,
                error=errors[0] if errors else None,
            )
            await session.commit()
        outcome = CleanupOutcome.DONE if cards_done and storage_done else CleanupOutcome.PARTIAL
        logger.info(
            "account_cleanup_ran",
            extra={
                "user_id": str(user_id),
                "outcome": outcome.value,
                "cards_detached": cards_done,
                "files_deleted": storage_done,
                "errors": errors,
            },
        )
        return outcome

    async def _detach(self, user_id: uuid.UUID, customer_id: str | None, errors: list[str]) -> bool:
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
        if not keys:
            return True
        if self._storage is None:
            errors.append("storage_not_configured")
            return False
        # Read before the pass: a pass that started before the time is never the last.
        final = datetime.now(UTC) >= settled_after
        try:
            result = await asyncio.to_thread(self._storage.delete_many, keys)
        except StorageUnavailableError as error:
            errors.append(type(error).__name__)
            return False
        if result.failed:
            errors.append("storage_delete_failed")
            return False
        return final
