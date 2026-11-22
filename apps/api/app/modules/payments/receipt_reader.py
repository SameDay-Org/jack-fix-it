"""What a receipt reads of a job's payment and of the money returned from it (#62), for the
receipts module (ADR 0003: it reads payments through here, never their models).

Every amount is a frozen row's: the payment's price and tax as charged, and each refund Stripe
says went through (`succeeded`, and not one staff abandoned). Nothing here reads the take rate,
the platform's fee or the pro's payout. The card is what Stripe's charge said once it was read
after the payment succeeded (receipts.tasks); it is stored once and never replaced.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.stripe_payments import CardFacts
from app.modules.payments.models import (
    STRIPE_REFUND_SUCCEEDED,
    Payment,
    PaymentStatus,
    Refund,
    RefundStatus,
)


@dataclass(frozen=True)
class ReceiptPayment:
    """A succeeded payment as its receipt shows it. `card` is None until it was read, and for a
    payment Stripe gave no card for."""

    payment_id: uuid.UUID
    request_id: uuid.UUID
    quote_id: uuid.UUID
    customer_id: uuid.UUID
    amount_cents: int
    tax_cents: int
    currency: str
    card: CardFacts | None
    # Never logged, never shown: what the card is read again with.
    payment_intent_id: str | None
    receipt_emailed_at: datetime | None


@dataclass(frozen=True)
class Returned:
    """Money that went back to the customer's payment method: one refund Stripe succeeded."""

    amount_cents: int
    # When the refund was asked for (its latest attempt, else its row): the day the customer
    # is told it went back.
    at: datetime


def card_facts(brand: str | None, last4: str | None, wallet: str | None) -> CardFacts | None:
    """The stored card, or None when nothing of it is stored."""
    if brand is None and last4 is None and wallet is None:
        return None
    return CardFacts(brand=brand, last4=last4, wallet=wallet)


def _receipt(payment: Payment) -> ReceiptPayment:
    return ReceiptPayment(
        payment_id=payment.id,
        request_id=payment.request_id,
        quote_id=payment.quote_id,
        customer_id=payment.customer_id,
        amount_cents=payment.amount_cents,
        tax_cents=payment.tax_cents,
        currency=payment.currency,
        card=card_facts(payment.card_brand, payment.card_last4, payment.wallet),
        payment_intent_id=payment.stripe_payment_intent_id,
        receipt_emailed_at=payment.receipt_emailed_at,
    )


class PaymentReceiptReader:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def of_quote(self, quote_id: uuid.UUID) -> ReceiptPayment | None:
        """The quote's succeeded payment (the one its job was created from), or None."""
        statement = (
            select(Payment)
            .where(Payment.quote_id == quote_id, Payment.status == PaymentStatus.SUCCEEDED)
            .execution_options(populate_existing=True)
        )
        payment = (await self._session.scalars(statement)).one_or_none()
        return None if payment is None else _receipt(payment)

    async def succeeded(self, payment_id: uuid.UUID) -> ReceiptPayment | None:
        """The payment, when it succeeded; None for any other."""
        statement = (
            select(Payment)
            .where(Payment.id == payment_id, Payment.status == PaymentStatus.SUCCEEDED)
            .execution_options(populate_existing=True)
        )
        payment = (await self._session.scalars(statement)).one_or_none()
        return None if payment is None else _receipt(payment)

    async def returned_of_job(self, job_id: uuid.UUID) -> list[Returned]:
        """The job's refunds Stripe says went through, oldest first. A refund still pending,
        failed or canceled at Stripe, or one staff abandoned, is not money returned."""
        at = func.coalesce(Refund.requested_at, Refund.created_at)
        statement = (
            select(Refund.amount_cents, at.label("at"))
            .where(
                Refund.job_id == job_id,
                Refund.stripe_status == STRIPE_REFUND_SUCCEEDED,
                Refund.status != RefundStatus.ABANDONED,
            )
            .order_by(at, Refund.id)
        )
        return [Returned(amount, when) for amount, when in await self._session.execute(statement)]

    async def store_card(self, payment_id: uuid.UUID, card: CardFacts) -> bool:
        """Stores the card Stripe's charge was paid with, unless one is stored: what was read
        first stands. False when nothing was written. The caller commits."""
        result = await self._session.execute(
            update(Payment)
            .where(
                Payment.id == payment_id,
                Payment.card_brand.is_(None),
                Payment.card_last4.is_(None),
                Payment.wallet.is_(None),
            )
            .values(card_brand=card.brand, card_last4=card.last4, wallet=card.wallet)
        )
        return bool(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of an UPDATE

    async def mark_emailed(self, payment_id: uuid.UUID) -> bool:
        """Records that the receipt email was accepted, once: False when it already was. The
        caller commits."""
        result = await self._session.execute(
            update(Payment)
            .where(Payment.id == payment_id, Payment.receipt_emailed_at.is_(None))
            .values(receipt_emailed_at=func.now())
        )
        return bool(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of an UPDATE
