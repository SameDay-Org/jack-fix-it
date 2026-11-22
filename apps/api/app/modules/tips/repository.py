import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final

from sqlalchemy import ColumnElement, Subquery, and_, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.tips.models import (
    TIP_TRANSFER_MADE,
    UNPAID_STATUSES,
    WAITING_CODES,
    Tip,
    TipChoice,
    TipRequest,
    TipStatus,
    TipTransferStatus,
)

# A tip transfer Stripe has not made: an attempt may start (#273 PR A2).
_TRANSFER_NOT_MADE: Final = frozenset(set(TipTransferStatus) - TIP_TRANSFER_MADE)

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

    async def get(self, tip_id: uuid.UUID) -> Tip | None:
        """The tip, unlocked: for reads."""
        statement = select(Tip).where(Tip.id == tip_id).execution_options(populate_existing=True)
        return (await self._session.scalars(statement)).one_or_none()

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


def _transfer_unchecked(retry_before: datetime) -> tuple[ColumnElement[bool], ...]:
    """A created tip transfer whose read after its create has not succeeded, last tried at or
    before `retry_before` (or never)."""
    return (
        Tip.transfer_status == TipTransferStatus.CREATED,
        Tip.stripe_transfer_id.is_not(None),
        Tip.transfer_reversal_checked_at.is_(None),
        or_(
            Tip.transfer_reversal_check_tried_at.is_(None),
            Tip.transfer_reversal_check_tried_at <= retry_before,
        ),
    )


class TipTransferRepository:
    """The transfer columns of tips (#273 PR A2; tips/transfers.py). Every write is a
    conditional UPDATE: a transfer Stripe made (created, reversed) is never taken back, and an
    attempt's outcome is written only while it is the row's attempt."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def job_of(self, tip_id: uuid.UUID) -> uuid.UUID | None:
        """The tip's job, unlocked (it never changes): the caller locks the job, then the tip."""
        return await self._session.scalar(select(Tip.job_id).where(Tip.id == tip_id))

    async def start_attempt(self, tip_id: uuid.UUID, now: datetime, key: str) -> int | None:
        """Stamps an attempt starting `now` and returns its number: pending, no error code, one
        more attempt, the key stored once (the same for every attempt). None once Stripe made
        the transfer. The caller holds the row's lock and commits before any Stripe call."""
        statement = (
            update(Tip)
            .where(
                Tip.id == tip_id,
                Tip.status == TipStatus.SUCCEEDED,
                Tip.transfer_status.in_(_TRANSFER_NOT_MADE),
            )
            .values(
                transfer_status=TipTransferStatus.PENDING,
                transfer_last_error_code=None,
                transfer_requested_at=now,
                transfer_attempts=Tip.transfer_attempts + 1,
                transfer_idempotency_key=func.coalesce(Tip.transfer_idempotency_key, key),
            )
            .returning(Tip.transfer_attempts)
        )
        return await self._session.scalar(statement)

    async def hold(self, tip_id: uuid.UUID, code: str) -> None:
        """Held with `code`, no attempt started (the pro cannot be paid yet, or staff must
        look); nothing once Stripe made the transfer. The caller holds the row's lock."""
        await self._session.execute(
            update(Tip)
            .where(
                Tip.id == tip_id,
                Tip.status == TipStatus.SUCCEEDED,
                Tip.transfer_status.in_(_TRANSFER_NOT_MADE),
            )
            .values(transfer_status=TipTransferStatus.HELD, transfer_last_error_code=code)
        )

    async def is_attempt(self, tip_id: uuid.UUID, attempt: int) -> bool:
        """Whether attempt number `attempt` is still the row's attempt under way, its row
        locked: no later one started, no outcome recorded, no transfer stored."""
        statement = (
            select(Tip.id)
            .where(
                Tip.id == tip_id,
                Tip.transfer_attempts == attempt,
                Tip.transfer_status == TipTransferStatus.PENDING,
                Tip.transfer_last_error_code.is_(None),
                Tip.stripe_transfer_id.is_(None),
            )
            .with_for_update()
        )
        return (await self._session.scalar(statement)) is not None

    async def end_attempt(
        self, tip_id: uuid.UUID, attempt: int, status: TipTransferStatus, code: str
    ) -> bool:
        """Ends attempt number `attempt` as failed (tried again) or held (staff's) with `code`.
        False (nothing written) when a later attempt started or the transfer was stored."""
        statement = (
            update(Tip)
            .where(
                Tip.id == tip_id,
                Tip.transfer_attempts == attempt,
                Tip.transfer_status == TipTransferStatus.PENDING,
                Tip.stripe_transfer_id.is_(None),
            )
            .values(transfer_status=status, transfer_last_error_code=code)
            .returning(Tip.id)
        )
        return (await self._session.scalar(statement)) is not None

    async def mark_created(self, tip_id: uuid.UUID, stripe_transfer_id: str, now: datetime) -> bool:
        """Stores the transfer Stripe made unless the row holds one already; False then. Its
        read after the create is still to succeed, and the caller's own starts `now`."""
        statement = (
            update(Tip)
            .where(
                Tip.id == tip_id,
                Tip.transfer_status.in_(_TRANSFER_NOT_MADE),
                Tip.stripe_transfer_id.is_(None),
            )
            .values(
                transfer_status=TipTransferStatus.CREATED,
                stripe_transfer_id=stripe_transfer_id,
                transfer_last_error_code=None,
                transfer_reversal_check_tried_at=now,
                transfer_reversal_checked_at=None,
            )
            .returning(Tip.id)
        )
        return (await self._session.scalar(statement)) is not None

    async def mark_reversed(self, stripe_transfer_id: str) -> tuple[uuid.UUID, uuid.UUID] | None:
        """created -> reversed for the tip holding this Stripe transfer; its (id, job id), or
        None when no tip holds it as created. Only the exact Stripe id selects the row."""
        statement = (
            update(Tip)
            .where(
                Tip.stripe_transfer_id == stripe_transfer_id,
                Tip.transfer_status == TipTransferStatus.CREATED,
            )
            .values(transfer_status=TipTransferStatus.REVERSED)
            .returning(Tip.id, Tip.job_id)
        )
        row = (await self._session.execute(statement)).one_or_none()
        return None if row is None else (row.id, row.job_id)

    async def due(
        self,
        payable: Subquery,
        blocked: Subquery,
        waiting_codes: frozenset[str],
        retry_before: datetime,
        limit: int,
    ) -> list[uuid.UUID]:
        """Up to `limit` ids of the succeeded tips whose transfer may be tried now: never
        flagged for staff (late_success_at), their pro can be paid out (`payable`: pro_id),
        their job had no dispute or refund (`blocked`: job_id), and the transfer is not made:
        never tried; failed, or an attempt started at or before `retry_before` (a dead
        worker's); or held for a reason in `waiting_codes` (the pro's payout setup). A tip held
        for staff is theirs. Least recently tried first (never tried before all), then by id.
        Unlocked: the release checks each again under its locks."""
        statement = (
            select(Tip.id)
            .join(payable, payable.c.pro_id == Tip.pro_id)
            .where(
                Tip.status == TipStatus.SUCCEEDED,
                Tip.late_success_at.is_(None),
                Tip.job_id.not_in(select(blocked.c.job_id)),
                or_(
                    Tip.transfer_status == TipTransferStatus.NONE,
                    Tip.transfer_status.in_((TipTransferStatus.FAILED, TipTransferStatus.PENDING))
                    & (
                        Tip.transfer_requested_at.is_(None)
                        | (Tip.transfer_requested_at <= retry_before)
                    ),
                    (Tip.transfer_status == TipTransferStatus.HELD)
                    & Tip.transfer_last_error_code.in_(waiting_codes),
                ),
            )
            .order_by(Tip.transfer_requested_at.asc().nulls_first(), Tip.id)
            .limit(limit)
        )
        return list((await self._session.scalars(statement)).all())

    async def unchecked_for_reversal(self, retry_before: datetime, limit: int) -> list[uuid.UUID]:
        """Up to `limit` ids of the created tip transfers whose read after the create has not
        succeeded (see _transfer_unchecked), least recently tried first, then by id. Unlocked:
        claim_reversal_check checks each again."""
        statement = (
            select(Tip.id)
            .where(*_transfer_unchecked(retry_before))
            .order_by(Tip.transfer_reversal_check_tried_at.asc().nulls_first(), Tip.id)
            .limit(limit)
        )
        return list((await self._session.scalars(statement)).all())

    async def claim_reversal_check(
        self, tip_id: uuid.UUID, now: datetime, retry_before: datetime
    ) -> str | None:
        """Stamps a reversal check starting `now` if the row still needs one and none started
        after `retry_before`; its Stripe transfer id then, else None. The caller commits before
        reading Stripe."""
        statement = (
            update(Tip)
            .where(Tip.id == tip_id, *_transfer_unchecked(retry_before))
            .values(transfer_reversal_check_tried_at=now)
            .returning(Tip.stripe_transfer_id)
        )
        return await self._session.scalar(statement)

    async def mark_reversal_checked(
        self, tip_id: uuid.UUID, stripe_transfer_id: str, now: datetime
    ) -> None:
        """The read of the stored transfer succeeded `now`. The caller commits."""
        await self._session.execute(
            update(Tip)
            .where(Tip.id == tip_id, Tip.stripe_transfer_id == stripe_transfer_id)
            .values(transfer_reversal_checked_at=now)
        )

    @staticmethod
    def payout_facts() -> Subquery:
        """Each succeeded tip's job (`job_id`), amount (`tip_cents`), whether Stripe made its
        transfer (`tip_made`: created or paid) and whether it was reversed since
        (`tip_reversed`) or is held for staff (`tip_held_for_staff`: a hold code other than the
        pro's own waits), for the pro's earnings. Never a Stripe id."""
        return (
            select(
                Tip.job_id.label("job_id"),
                Tip.amount_cents.label("tip_cents"),
                Tip.transfer_status.in_((TipTransferStatus.CREATED, TipTransferStatus.PAID)).label(
                    "tip_made"
                ),
                (Tip.transfer_status == TipTransferStatus.REVERSED).label("tip_reversed"),
                # Held for staff (any hold code but the pro's own waits): on hold, not pending.
                and_(
                    Tip.transfer_status == TipTransferStatus.HELD,
                    Tip.transfer_last_error_code.not_in(WAITING_CODES),
                ).label("tip_held_for_staff"),
            )
            .where(Tip.status == TipStatus.SUCCEEDED)
            .subquery()
        )
