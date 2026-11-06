import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.payments.models import Payment


class PaymentRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_by_quote_for_update(self, quote_id: uuid.UUID) -> Payment | None:
        """The quote's payment, locked until the transaction ends; None before the first
        payment call. Take the request's lock first. populate_existing: a waiter gets the row
        as the transaction that held the lock left it."""
        statement = (
            select(Payment)
            .where(Payment.quote_id == quote_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def get_for_update(self, payment_id: uuid.UUID) -> Payment | None:
        """The payment, locked until the transaction ends, read as last committed."""
        statement = (
            select(Payment)
            .where(Payment.id == payment_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def add(self, payment: Payment) -> Payment:
        """Inserts the payment now (flush), so the unique quote surfaces here."""
        self._session.add(payment)
        await self._session.flush()
        return payment

    async def set_payment_intent_if_missing(self, payment_id: uuid.UUID, intent_id: str) -> bool:
        """Stores the PaymentIntent's id unless the row holds one already; False then. The
        caller holds the row's lock, so False means its own read was stale."""
        result = await self._session.execute(
            update(Payment)
            .where(Payment.id == payment_id, Payment.stripe_payment_intent_id.is_(None))
            .values(stripe_payment_intent_id=intent_id)
        )
        return bool(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of an UPDATE
