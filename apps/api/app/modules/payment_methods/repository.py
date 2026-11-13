import uuid
from typing import Final

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

# Postgres: a lock was not granted within `lock_timeout`.
_LOCK_NOT_AVAILABLE: Final = "55P03"


class WalletBusyError(Exception):
    """Another change of the same customer's wallet held its lock for the whole wait."""


class PaymentMethodRepository:
    """The wallet keeps no table (the cards live in Stripe): only the lock that makes the
    changes of one customer's wallet run one at a time, across API processes (#253)."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        # True once the last `lock_wallet` had its connection and asked Postgres for the lock:
        # a caller that cuts the call short reads here what it was waiting for.
        self.asked_for_lock = False

    async def lock_wallet(self, user_id: uuid.UUID, *, wait_seconds: float) -> None:
        """Transaction-scoped advisory lock on the user's wallet, waiting at most
        `wait_seconds` for another change to end: `WalletBusyError` past that, and the
        transaction must be rolled back. The wait limit lasts as long as the transaction.

        The limit is Postgres's, on the lock alone. A session that holds no connection gets
        one from the pool first, and that wait is the caller's to bound."""
        self.asked_for_lock = False
        # 0 would wait for ever.
        milliseconds = max(1, round(wait_seconds * 1000))
        await self._session.execute(
            text("SELECT set_config('lock_timeout', :milliseconds, true)"),
            {"milliseconds": str(milliseconds)},
        )
        self.asked_for_lock = True
        try:
            await self._session.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                {"key": f"payment-methods:{user_id}"},
            )
        except DBAPIError as error:
            if getattr(error.orig, "sqlstate", None) != _LOCK_NOT_AVAILABLE:
                raise
            raise WalletBusyError from None
