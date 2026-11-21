"""What a receipt reads of a job's tip (#62), for the receipts module (ADR 0003): only a tip
that succeeded, with the amount as charged and the card Stripe's charge was paid with (read
once after the tip succeeded, receipts.tasks, and never replaced)."""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.stripe_payments import CardFacts
from app.modules.payments.receipt_reader import card_facts
from app.modules.tips.models import Tip, TipStatus


@dataclass(frozen=True)
class ReceiptTip:
    tip_id: uuid.UUID
    job_id: uuid.UUID
    request_id: uuid.UUID
    customer_id: uuid.UUID
    pro_id: uuid.UUID
    amount_cents: int
    currency: str
    succeeded_at: datetime
    card: CardFacts | None
    # Never logged, never shown: what the card is read again with.
    payment_intent_id: str | None
    receipt_emailed_at: datetime | None


def _receipt(tip: Tip) -> ReceiptTip | None:
    if tip.status is not TipStatus.SUCCEEDED or tip.succeeded_at is None:
        return None
    return ReceiptTip(
        tip_id=tip.id,
        job_id=tip.job_id,
        request_id=tip.request_id,
        customer_id=tip.customer_id,
        pro_id=tip.pro_id,
        amount_cents=tip.amount_cents,
        currency=tip.currency,
        succeeded_at=tip.succeeded_at,
        card=card_facts(tip.card_brand, tip.card_last4, tip.wallet),
        payment_intent_id=tip.stripe_payment_intent_id,
        receipt_emailed_at=tip.receipt_emailed_at,
    )


class TipReceiptReader:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def of_job(self, job_id: uuid.UUID) -> ReceiptTip | None:
        """The job's tip when it succeeded; None for no tip, or one not paid."""
        statement = (
            select(Tip).where(Tip.job_id == job_id).execution_options(populate_existing=True)
        )
        tip = (await self._session.scalars(statement)).one_or_none()
        return None if tip is None else _receipt(tip)

    async def succeeded(self, tip_id: uuid.UUID) -> ReceiptTip | None:
        statement = select(Tip).where(Tip.id == tip_id).execution_options(populate_existing=True)
        tip = (await self._session.scalars(statement)).one_or_none()
        return None if tip is None else _receipt(tip)

    async def store_card(self, tip_id: uuid.UUID, card: CardFacts) -> bool:
        """As PaymentReceiptReader.store_card: what was read first stands."""
        result = await self._session.execute(
            update(Tip)
            .where(
                Tip.id == tip_id,
                Tip.card_brand.is_(None),
                Tip.card_last4.is_(None),
                Tip.wallet.is_(None),
            )
            .values(card_brand=card.brand, card_last4=card.last4, wallet=card.wallet)
        )
        return bool(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of an UPDATE

    async def mark_emailed(self, tip_id: uuid.UUID) -> bool:
        result = await self._session.execute(
            update(Tip)
            .where(Tip.id == tip_id, Tip.receipt_emailed_at.is_(None))
            .values(receipt_emailed_at=func.now())
        )
        return bool(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of an UPDATE
