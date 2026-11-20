import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.tips.models import UNPAID_STATUSES, Tip, TipChoice, TipRequest, TipStatus

# The columns a choice writes: what the customer chose and the amount it comes to.
_NO_TIP: Final = {"choice": TipChoice.NONE, "percent": None, "amount_cents": 0}


@dataclass(frozen=True)
class NewTip:
    """The job's ids and currency a new tip copies."""

    job_id: uuid.UUID
    request_id: uuid.UUID
    customer_id: uuid.UUID
    pro_id: uuid.UUID
    currency: str


class TipRepository:
    """tips (#273). Every change is a conditional UPDATE on the row the caller locked: the
    status, the attempt and the PaymentIntent move together, never one without the others."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_by_job(self, job_id: uuid.UUID) -> Tip | None:
        """The job's tip, unlocked: for reads."""
        statement = (
            select(Tip).where(Tip.job_id == job_id).execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def insert_if_missing(
        self, new: NewTip, choice: TipChoice, percent: int | None, amount_cents: int
    ) -> None:
        """Adds the job's tip with the customer's first choice unless the job has one (the
        unique job_id): two first choices at once make one row, and the caller locks whichever
        was kept and checks it as it would any other. A tip to pay starts at attempt 1."""
        declined = choice is TipChoice.NONE
        await self._session.execute(
            insert(Tip)
            .values(
                job_id=new.job_id,
                request_id=new.request_id,
                customer_id=new.customer_id,
                pro_id=new.pro_id,
                currency=new.currency,
                choice=choice,
                percent=percent,
                amount_cents=amount_cents,
                status=TipStatus.DECLINED if declined else TipStatus.REQUIRES_PAYMENT,
                attempt=0 if declined else 1,
            )
            .on_conflict_do_nothing(index_elements=[Tip.job_id])
        )

    async def get_by_job_for_update(self, job_id: uuid.UUID) -> Tip | None:
        """The job's tip, locked until the transaction ends. populate_existing: a waiter gets
        the row as the transaction that held the lock left it."""
        statement = (
            select(Tip)
            .where(Tip.job_id == job_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def get_for_update(self, tip_id: uuid.UUID) -> Tip | None:
        statement = (
            select(Tip)
            .where(Tip.id == tip_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def get_by_intent_for_update(self, intent_id: str) -> Tip | None:
        """The tip whose current attempt is this PaymentIntent, locked; None for any other."""
        statement = (
            select(Tip)
            .where(Tip.stripe_payment_intent_id == intent_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def decline(self, tip_id: uuid.UUID) -> None:
        """ "No tip": declined, with no PaymentIntent. The caller holds the lock and has made
        sure no PaymentIntent of the tip can still be paid."""
        await self._session.execute(
            update(Tip)
            .where(Tip.id == tip_id, Tip.status != TipStatus.SUCCEEDED)
            .values(
                **_NO_TIP,
                status=TipStatus.DECLINED,
                stripe_payment_intent_id=None,
                payment_intent_requested_at=None,
                create_refused_at=None,
            )
        )

    async def new_attempt(
        self, tip_id: uuid.UUID, choice: TipChoice, percent: int | None, amount_cents: int
    ) -> None:
        """A new PaymentIntent to ask for, for this choice: the attempt counts up (a new
        idempotency key), with no intent and no create sent yet. The caller holds the lock and
        has made sure no PaymentIntent of the tip can still be paid."""
        await self._session.execute(
            update(Tip)
            .where(Tip.id == tip_id, Tip.status != TipStatus.SUCCEEDED)
            .values(
                choice=choice,
                percent=percent,
                amount_cents=amount_cents,
                status=TipStatus.REQUIRES_PAYMENT,
                attempt=Tip.attempt + 1,
                stripe_payment_intent_id=None,
                payment_intent_requested_at=None,
                create_refused_at=None,
            )
        )

    async def clear_payment_intent_requested(self, tip_id: uuid.UUID, attempt: int) -> None:
        """Forgets the current attempt's create (staff's recovery: Stripe made nothing under
        its key), while the attempt holds no intent. The caller holds the lock and commits."""
        await self._session.execute(
            update(Tip)
            .where(
                Tip.id == tip_id,
                Tip.attempt == attempt,
                Tip.stripe_payment_intent_id.is_(None),
            )
            .values(payment_intent_requested_at=None)
        )

    async def mark_create_refused(self, tip_id: uuid.UUID, attempt: int) -> None:
        """Stripe refused this attempt's create for good: no PaymentIntent exists under its
        key. The caller holds the lock and commits."""
        await self._session.execute(
            update(Tip)
            .where(
                Tip.id == tip_id,
                Tip.attempt == attempt,
                Tip.stripe_payment_intent_id.is_(None),
            )
            .values(create_refused_at=func.now())
        )

    async def flag_late_success(self, tip_id: uuid.UUID) -> bool:
        """An earlier attempt's PaymentIntent succeeded: flagged once, for staff. False when it
        already was. The caller holds the lock."""
        result = await self._session.execute(
            update(Tip)
            .where(Tip.id == tip_id, Tip.late_success_at.is_(None))
            .values(late_success_at=func.now())
        )
        return bool(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of an UPDATE

    async def request_by_key(
        self, customer_id: uuid.UUID, idempotency_key: uuid.UUID
    ) -> TipRequest | None:
        """The customer's choice made with this key, if any."""
        statement = (
            select(TipRequest)
            .where(
                TipRequest.customer_id == customer_id,
                TipRequest.idempotency_key == idempotency_key,
            )
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def add_request(
        self,
        *,
        job_id: uuid.UUID,
        customer_id: uuid.UUID,
        idempotency_key: uuid.UUID,
        fingerprint: str,
        attempt: int | None,
    ) -> TipRequest | None:
        """Records a choice made with a key. None when this call recorded it; else the record
        already there (the first record stands), for the caller to compare: the same job and
        body is a concurrent call of the same choice, anything else a reused key (#510 round
        2: the conflict is read, never silent)."""
        inserted = await self._session.scalar(
            insert(TipRequest)
            .values(
                job_id=job_id,
                customer_id=customer_id,
                idempotency_key=idempotency_key,
                fingerprint=fingerprint,
                attempt=attempt,
            )
            .on_conflict_do_nothing(
                index_elements=[TipRequest.customer_id, TipRequest.idempotency_key]
            )
            .returning(TipRequest.id)
        )
        if inserted is not None:
            return None
        statement = (
            select(TipRequest)
            .where(
                TipRequest.customer_id == customer_id,
                TipRequest.idempotency_key == idempotency_key,
            )
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one()

    async def retry_failed(self, tip_id: uuid.UUID, intent_id: str) -> None:
        """failed -> requires_payment: the same PaymentIntent is confirmed again (Stripe keeps
        a failed intent payable)."""
        await self._session.execute(
            update(Tip)
            .where(
                Tip.id == tip_id,
                Tip.stripe_payment_intent_id == intent_id,
                Tip.status == TipStatus.FAILED,
            )
            .values(status=TipStatus.REQUIRES_PAYMENT)
        )

    async def mark_payment_intent_requested(self, tip_id: uuid.UUID, attempt: int) -> None:
        """Stamps the attempt's first create now; the caller holds the lock and commits before
        the create call."""
        await self._session.execute(
            update(Tip)
            .where(Tip.id == tip_id, Tip.attempt == attempt)
            .values(payment_intent_requested_at=func.now())
        )

    async def set_payment_intent_if_missing(
        self, tip_id: uuid.UUID, attempt: int, intent_id: str
    ) -> bool:
        """Stores the attempt's PaymentIntent unless the row holds one, or moved to another
        attempt; False then. The caller holds the lock."""
        result = await self._session.execute(
            update(Tip)
            .where(
                Tip.id == tip_id,
                Tip.attempt == attempt,
                Tip.stripe_payment_intent_id.is_(None),
            )
            .values(stripe_payment_intent_id=intent_id)
        )
        return bool(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of an UPDATE

    async def move_status(
        self, tip_id: uuid.UUID, intent_id: str, from_status: TipStatus, to: TipStatus
    ) -> bool:
        """from_status -> to for the tip's current PaymentIntent; succeeded stamps its time. A
        conditional UPDATE, so it happens once; False when the row moved on."""
        values: dict[str, object] = {"status": to}
        if to is TipStatus.SUCCEEDED:
            values["succeeded_at"] = func.now()
        result = await self._session.execute(
            update(Tip)
            .where(
                Tip.id == tip_id,
                Tip.stripe_payment_intent_id == intent_id,
                Tip.status == from_status,
            )
            .values(**values)
        )
        return bool(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of an UPDATE

    async def unpaid_due(
        self, requested_before: datetime, after: uuid.UUID | None, limit: int
    ) -> list[uuid.UUID]:
        """Up to `limit` ids, in id order after `after`, of the tips still waiting to be paid
        (requires_payment or failed; never processing) whose current PaymentIntent was asked
        for before `requested_before`. Read without a lock: the caller locks each one and
        checks it again."""
        statement = (
            select(Tip.id)
            .where(
                Tip.status.in_(UNPAID_STATUSES),
                Tip.stripe_payment_intent_id.is_not(None),
                Tip.payment_intent_requested_at < requested_before,
            )
            .order_by(Tip.id)
            .limit(limit)
        )
        if after is not None:
            statement = statement.where(Tip.id > after)
        return list((await self._session.scalars(statement)).all())
