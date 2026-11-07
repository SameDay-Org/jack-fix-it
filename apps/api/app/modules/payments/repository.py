import uuid
from datetime import datetime

from sqlalchemy import ColumnElement, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.payments.models import UNPAID_STATUSES, Payment, PaymentStatus


class PaymentRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_live_by_quote_for_update(self, quote_id: uuid.UUID) -> Payment | None:
        """The quote's live payment (any status but canceled; at most one, a partial unique
        index), locked until the transaction ends; None before the first payment call of this
        acceptance. Take the request's lock first. populate_existing: a waiter gets the row as
        the transaction that held the lock left it."""
        statement = (
            select(Payment)
            .where(Payment.quote_id == quote_id, Payment.status != PaymentStatus.CANCELED)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def find_by_intent(self, intent_id: str) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID] | None:
        """The ids of the payment, its request and its quote for a PaymentIntent id, read
        without a lock (the caller locks the request, the quote, then the payment); None for an
        unknown intent."""
        return await self._ids(Payment.stripe_payment_intent_id == intent_id)

    async def find_ids(
        self, payment_id: uuid.UUID
    ) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID] | None:
        """The ids of the payment, its request and its quote, read without a lock (the caller
        locks the request, the quote, then the payment); None when no such payment exists."""
        return await self._ids(Payment.id == payment_id)

    async def _ids(
        self, where: ColumnElement[bool]
    ) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID] | None:
        statement = select(Payment.id, Payment.request_id, Payment.quote_id).where(where)
        row = (await self._session.execute(statement)).one_or_none()
        return None if row is None else (row.id, row.request_id, row.quote_id)

    async def unpaid_due(
        self, created_before: datetime, after: uuid.UUID | None, limit: int
    ) -> list[uuid.UUID]:
        """Up to `limit` ids, in id order after `after`, of the payments still waiting to be
        paid (requires_payment or failed; never processing) created before `created_before`
        (#297). Read without a lock: the caller locks each one and checks it again."""
        statement = (
            select(Payment.id)
            .where(
                Payment.status.in_(UNPAID_STATUSES),
                Payment.created_at < created_before,
            )
            .order_by(Payment.id)
            .limit(limit)
        )
        if after is not None:
            statement = statement.where(Payment.id > after)
        return list((await self._session.scalars(statement)).all())

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

    async def mark_payment_intent_requested(self, payment_id: uuid.UUID) -> None:
        """Stamps the first create attempt now; the caller holds the row's lock and commits
        before the create call."""
        await self._session.execute(
            update(Payment)
            .where(Payment.id == payment_id)
            .values(payment_intent_requested_at=func.now())
        )

    async def clear_payment_intent_requested(self, payment_id: uuid.UUID) -> None:
        """Forgets the unresolved create (staff recovery), so the next call creates again; the
        caller holds the row's lock and commits."""
        await self._session.execute(
            update(Payment).where(Payment.id == payment_id).values(payment_intent_requested_at=None)
        )

    async def set_payment_intent_if_missing(self, payment_id: uuid.UUID, intent_id: str) -> bool:
        """Stores the PaymentIntent's id unless the row holds one already; False then. The
        caller holds the row's lock, so False means its own read was stale."""
        result = await self._session.execute(
            update(Payment)
            .where(Payment.id == payment_id, Payment.stripe_payment_intent_id.is_(None))
            .values(stripe_payment_intent_id=intent_id)
        )
        return bool(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of an UPDATE
