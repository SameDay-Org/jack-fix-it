import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.payments.models import Payment, PaymentStatus


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

    async def find_by_intent(self, intent_id: str) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID] | None:
        """The ids of the payment, its request and its quote for a PaymentIntent id, read
        without a lock (the caller locks the request, the quote, then the payment); None for an
        unknown intent."""
        statement = select(Payment.id, Payment.request_id, Payment.quote_id).where(
            Payment.stripe_payment_intent_id == intent_id
        )
        row = (await self._session.execute(statement)).one_or_none()
        return None if row is None else (row.id, row.request_id, row.quote_id)

    async def move_status(
        self, payment_id: uuid.UUID, from_status: PaymentStatus, to: PaymentStatus
    ) -> bool:
        """from_status -> to; a conditional UPDATE, so it happens once. The caller holds the
        row's lock and checks the edge against PAYMENT_TRANSITIONS. False when the row was no
        longer in from_status."""
        statement = (
            update(Payment)
            .where(Payment.id == payment_id, Payment.status == from_status)
            .values(status=to)
            .returning(Payment.id)
        )
        return (await self._session.scalar(statement)) is not None

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
