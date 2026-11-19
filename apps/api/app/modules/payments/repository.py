import uuid
from collections.abc import Collection
from datetime import datetime
from typing import Final

from sqlalchemy import ColumnElement, Select, Subquery, and_, case, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.payments.models import (
    MADE_STATUSES,
    REFUND_NOT_MADE,
    STRIPE_RANK_DEAD,
    STRIPE_RANK_NONE,
    STRIPE_RANK_SUCCEEDED,
    STRIPE_RANK_UNFINISHED,
    STRIPE_REFUND_DEAD,
    STRIPE_REFUND_SUCCEEDED,
    UNPAID_STATUSES,
    Payment,
    PaymentStatus,
    Refund,
    RefundStatus,
    Transfer,
    TransferStatus,
    stripe_status_rank,
)

# Statuses of a transfer Stripe has not made: the only ones an attempt may leave or enter.
_NOT_MADE: Final = tuple(status for status in TransferStatus if status not in MADE_STATUSES)


def _reversal_unchecked(retry_before: datetime) -> tuple[ColumnElement[bool], ...]:
    """A created transfer, its Stripe id stored, whose reversal check has not succeeded and was
    last tried at or before `retry_before` (or never). Nothing about its job: by then the job
    is paid_out, which no release or sweep reads."""
    return (
        Transfer.status == TransferStatus.CREATED,
        Transfer.stripe_transfer_id.is_not(None),
        Transfer.reversal_checked_at.is_(None),
        or_(
            Transfer.reversal_check_tried_at.is_(None),
            Transfer.reversal_check_tried_at <= retry_before,
        ),
    )


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

    async def intent_of(self, payment_id: uuid.UUID) -> str | None:
        """The payment's PaymentIntent id, as last committed; None without one."""
        statement = select(Payment.stripe_payment_intent_id).where(Payment.id == payment_id)
        return await self._session.scalar(statement)

    async def succeeded_of_quote(self, quote_id: uuid.UUID) -> Payment | None:
        """The quote's payment that succeeded: the one its job was created from (#61), so
        the one its transfer pays from (#68). At most one (a quote has one live payment, and
        succeeded is terminal); None when the quote has none. Unlocked: nothing about a
        succeeded payment changes."""
        statement = select(Payment).where(
            Payment.quote_id == quote_id, Payment.status == PaymentStatus.SUCCEEDED
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def succeeded_of_quotes(
        self, quote_ids: Collection[uuid.UUID]
    ) -> dict[uuid.UUID, Payment]:
        """succeeded_of_quote for each of `quote_ids` that has one, by quote, in one statement."""
        if not quote_ids:
            return {}
        statement = select(Payment).where(
            Payment.quote_id.in_(quote_ids), Payment.status == PaymentStatus.SUCCEEDED
        )
        return {payment.quote_id: payment for payment in await self._session.scalars(statement)}

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


class TransferRepository:
    """transfers (#68). status is written here only, by conditional UPDATEs: a transfer Stripe
    made (created, reversed) is never taken back to pending or failed."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    @staticmethod
    def payout_facts() -> Subquery:
        """Every transfer row's job (`job_id`), amount (`amount_cents`), whether Stripe made it
        (`made`: created) and whether it was reversed since (`reversed`), for the pro's
        earnings (#70). Never a Stripe id."""
        return select(
            Transfer.job_id.label("job_id"),
            Transfer.amount_cents.label("amount_cents"),
            (Transfer.status == TransferStatus.CREATED).label("made"),
            (Transfer.status == TransferStatus.REVERSED).label("reversed"),
        ).subquery()

    async def get_of_job_for_update(self, job_id: uuid.UUID) -> Transfer | None:
        """The job's transfer row, locked until the transaction ends, read as last committed;
        None before the first release of the job. Take the job's lock first."""
        statement = (
            select(Transfer)
            .where(Transfer.job_id == job_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def get_of_job(self, job_id: uuid.UUID) -> Transfer | None:
        statement = (
            select(Transfer)
            .where(Transfer.job_id == job_id)
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def statuses_of_jobs(
        self, job_ids: Collection[uuid.UUID]
    ) -> dict[uuid.UUID, TransferStatus]:
        """Each job's transfer status, for the jobs among `job_ids` that have a row."""
        if not job_ids:
            return {}
        statement = select(Transfer.job_id, Transfer.status).where(Transfer.job_id.in_(job_ids))
        return {row.job_id: row.status for row in await self._session.execute(statement)}

    async def add(self, transfer: Transfer) -> Transfer:
        """Inserts the row now (flush), so a second row for the job surfaces here."""
        self._session.add(transfer)
        await self._session.flush()
        return transfer

    async def start_attempt(self, transfer_id: uuid.UUID, now: datetime) -> int | None:
        """Stamps a Stripe attempt starting at `now` and returns its number: pending, no
        error code, one more attempt. None (nothing written) once Stripe made the transfer.
        The caller holds the row's lock and commits before the Stripe call."""
        statement = (
            update(Transfer)
            .where(Transfer.id == transfer_id, Transfer.status.in_(_NOT_MADE))
            .values(
                status=TransferStatus.PENDING,
                last_error_code=None,
                requested_at=now,
                attempts=Transfer.attempts + 1,
            )
            .returning(Transfer.attempts)
        )
        return await self._session.scalar(statement)

    async def hold_back(self, transfer_id: uuid.UUID, code: str) -> None:
        """Leaves the row pending with `code`, the reason no attempt was started (the pro
        cannot be paid out yet); nothing once Stripe made the transfer. The caller holds the
        row's lock and commits."""
        await self._session.execute(
            update(Transfer)
            .where(Transfer.id == transfer_id, Transfer.status.in_(_NOT_MADE))
            .values(status=TransferStatus.PENDING, last_error_code=code)
        )

    async def mark_failed(self, transfer_id: uuid.UUID, attempt: int, code: str) -> bool:
        """Ends attempt number `attempt` as failed with `code`. False (nothing written) when a
        later attempt started meanwhile or the transfer was stored: this attempt's failure no
        longer says where the row stands."""
        statement = (
            update(Transfer)
            .where(
                Transfer.id == transfer_id,
                Transfer.attempts == attempt,
                Transfer.status == TransferStatus.PENDING,
                Transfer.stripe_transfer_id.is_(None),
            )
            .values(status=TransferStatus.FAILED, last_error_code=code)
            .returning(Transfer.id)
        )
        return (await self._session.scalar(statement)) is not None

    async def mark_created(
        self, transfer_id: uuid.UUID, stripe_transfer_id: str, now: datetime
    ) -> bool:
        """Stores the transfer Stripe made unless the row holds one already; False then. Its
        reversal check is still to succeed, and the caller's own starts `now`. The caller
        commits it together with the job's move to paid_out."""
        statement = (
            update(Transfer)
            .where(
                Transfer.id == transfer_id,
                Transfer.status.in_(_NOT_MADE),
                Transfer.stripe_transfer_id.is_(None),
            )
            .values(
                status=TransferStatus.CREATED,
                stripe_transfer_id=stripe_transfer_id,
                last_error_code=None,
                reversal_check_tried_at=now,
                reversal_checked_at=None,
            )
            .returning(Transfer.id)
        )
        return (await self._session.scalar(statement)) is not None

    async def unchecked_for_reversal(self, retry_before: datetime, limit: int) -> list[uuid.UUID]:
        """Up to `limit` ids of the created transfers whose reversal check has not succeeded
        and was last tried at or before `retry_before` (or never), least recently tried first,
        then by id: a check that keeps failing goes to the back. Whatever the job's state: the
        job is paid_out by then. Unlocked; claim_reversal_check checks each again."""
        statement = (
            select(Transfer.id)
            .where(*_reversal_unchecked(retry_before))
            .order_by(Transfer.reversal_check_tried_at.asc().nulls_first(), Transfer.id)
            .limit(limit)
        )
        return list((await self._session.scalars(statement)).all())

    async def claim_reversal_check(
        self, transfer_id: uuid.UUID, now: datetime, retry_before: datetime
    ) -> str | None:
        """Stamps a reversal check starting `now` on the row if it still needs one and none
        started after `retry_before`; its Stripe transfer id then, else None. The UPDATE takes
        the row's lock, so of two claims the second sees the first's stamp once it commits.
        The caller commits before reading Stripe."""
        statement = (
            update(Transfer)
            .where(Transfer.id == transfer_id, *_reversal_unchecked(retry_before))
            .values(reversal_check_tried_at=now)
            .returning(Transfer.stripe_transfer_id)
        )
        return await self._session.scalar(statement)

    async def mark_reversal_checked(
        self, transfer_id: uuid.UUID, stripe_transfer_id: str, now: datetime
    ) -> None:
        """The read of the row's stored transfer succeeded `now` (a reversal it found is
        recorded in the same transaction). The caller commits."""
        await self._session.execute(
            update(Transfer)
            .where(Transfer.id == transfer_id, Transfer.stripe_transfer_id == stripe_transfer_id)
            .values(reversal_checked_at=now)
        )

    async def mark_reversed(self, stripe_transfer_id: str) -> tuple[uuid.UUID, uuid.UUID] | None:
        """created -> reversed for the row holding this Stripe transfer; its (id, job id), or
        None when no row holds it or it is reversed already."""
        statement = (
            update(Transfer)
            .where(
                Transfer.stripe_transfer_id == stripe_transfer_id,
                Transfer.status == TransferStatus.CREATED,
            )
            .values(status=TransferStatus.REVERSED)
            .returning(Transfer.id, Transfer.job_id)
        )
        row = (await self._session.execute(statement)).one_or_none()
        return None if row is None else (row.id, row.job_id)

    async def due(
        self,
        confirmed: Subquery,
        payable: Subquery,
        held: Subquery,
        retry_before: datetime,
        limit: int,
    ) -> list[uuid.UUID]:
        """Up to `limit` ids of the confirmed jobs whose transfer is still to be made and may
        be tried now (#68's sweep): the job is confirmed (`confirmed`: job_id, pro_id), its pro
        can be paid out (`payable`: pro_id), and it has no transfer row, or one Stripe has not
        made whose latest attempt, if any, started at or before `retry_before`. So an attempt
        under way is left alone, and a failed one waits its turn. A job with no row is due only
        when release would get past its payment checks (a succeeded payment of the job's quote,
        with its PaymentIntent and the job's own positive payout): release refuses any other
        before writing a row (an ERROR for staff, logged when the confirmation's release ran), so
        it would come first in every run and, with enough of them, hold every other job up.
        Also a confirmed job whose row
        says created: staff stored the transfer by hand after a review, and release moves the
        job to paid_out. Least recently tried first (never tried before all), then by job id: a
        job that keeps failing goes to the back, so it never holds the others up. Unlocked:
        release checks each job again under its lock."""
        releasable = (
            select(Payment.id)
            .where(
                Payment.quote_id == confirmed.c.quote_id,
                Payment.status == PaymentStatus.SUCCEEDED,
                Payment.stripe_payment_intent_id.is_not(None),
                Payment.pro_payout_cents == confirmed.c.pro_payout_cents,
            )
            .exists()
        )
        statement = (
            select(confirmed.c.job_id)
            .join(payable, payable.c.pro_id == confirmed.c.pro_id)
            .outerjoin(Transfer, Transfer.job_id == confirmed.c.job_id)
            # A held job (`held`: job_id; an open dispute, or a dispute refund Stripe has not
            # finished) is never released (has_open_hold).
            .where(confirmed.c.job_id.not_in(select(held.c.job_id)))
            .where(
                or_(
                    Transfer.id.is_(None) & (confirmed.c.pro_payout_cents > 0) & releasable,
                    Transfer.status.in_(_NOT_MADE)
                    & (Transfer.requested_at.is_(None) | (Transfer.requested_at <= retry_before)),
                    Transfer.status == TransferStatus.CREATED,
                )
            )
            .order_by(Transfer.requested_at.asc().nulls_first(), confirmed.c.job_id)
            .limit(limit)
        )
        return list((await self._session.scalars(statement)).all())


class RefundRepository:
    """The refunds table (#76). Status writes are statements, never attribute assignments (the
    single-writer guard), each conditional on the status it leaves."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def current_of_dispute_for_update(self, dispute_id: uuid.UUID) -> Refund | None:
        """The dispute's refund that is not abandoned (one at most: a partial unique index),
        locked until the transaction ends, read as last committed; None before the first
        attempt, or once staff abandoned the last one (#434). Take the job's lock first."""
        statement = (
            select(Refund)
            .where(Refund.dispute_id == dispute_id, Refund.status != RefundStatus.ABANDONED)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def all_of_dispute(self, dispute_id: uuid.UUID) -> list[Refund]:
        """Every refund of the dispute, abandoned ones included, unlocked."""
        statement = (
            select(Refund)
            .where(Refund.dispute_id == dispute_id)
            .execution_options(populate_existing=True)
        )
        return list((await self._session.scalars(statement)).all())

    async def all_of_dispute_for_update(self, dispute_id: uuid.UUID) -> list[Refund]:
        """Every refund of the dispute, abandoned ones included, locked until the transaction
        ends (in id order, so two lockers never deadlock), read as last committed. Take the
        job's and the dispute's locks first."""
        statement = (
            select(Refund)
            .where(Refund.dispute_id == dispute_id)
            .order_by(Refund.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return list((await self._session.scalars(statement)).all())

    async def abandoned_of_dispute(self, dispute_id: uuid.UUID) -> int:
        """How many of the dispute's refunds staff abandoned (#434)."""
        statement = select(func.count()).where(
            Refund.dispute_id == dispute_id, Refund.status == RefundStatus.ABANDONED
        )
        return int(await self._session.scalar(statement) or 0)

    async def of_dispute(self, dispute_id: uuid.UUID) -> Refund | None:
        """The dispute's refund that is not abandoned (one at most), unlocked."""
        statement = (
            select(Refund)
            .where(Refund.dispute_id == dispute_id, Refund.status != RefundStatus.ABANDONED)
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def mark_abandoned(self, refund_id: uuid.UUID) -> bool:
        """Staff gave the refund up (#434); False (nothing written) when it was abandoned
        already. The caller checked, under the row's lock, that it cannot move money, and
        commits it with its audit row."""
        statement = (
            update(Refund)
            .where(Refund.id == refund_id, Refund.status != RefundStatus.ABANDONED)
            .values(status=RefundStatus.ABANDONED)
            .returning(Refund.id)
        )
        return (await self._session.scalar(statement)) is not None

    async def by_key(self, key: str) -> Refund | None:
        """The row with this idempotency key (unique), unlocked, read as last committed."""
        statement = (
            select(Refund)
            .where(Refund.idempotency_key == key)
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def by_key_for_update(self, key: str) -> Refund | None:
        """The row with this idempotency key, locked until the transaction ends, read as last
        committed."""
        statement = (
            select(Refund)
            .where(Refund.idempotency_key == key)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def due_cancel_refunds(
        self, key_prefix: str, needs_review_code: str, tried_before: datetime, limit: int
    ) -> list[uuid.UUID]:
        """The job of each cancellation refund (#69: no dispute, its key under `key_prefix`)
        left without Stripe's answer: no Stripe refund stored, not refused for good, not for
        staff (`needs_review_code`), and its latest try (or its creation, before the first)
        before `tried_before`. Least recently tried first."""
        since = func.coalesce(Refund.requested_at, Refund.created_at)
        statement = (
            select(Refund.job_id)
            .where(
                Refund.dispute_id.is_(None),
                Refund.idempotency_key.startswith(key_prefix, autoescape=True),
                Refund.stripe_refund_id.is_(None),
                Refund.status.in_(REFUND_NOT_MADE),
                Refund.last_error_definitive.is_(False),
                Refund.last_error_code.is_distinct_from(needs_review_code),
                since < tried_before,
            )
            .order_by(since, Refund.id)
            .limit(limit)
        )
        return list(await self._session.scalars(statement))

    async def add(self, refund: Refund) -> Refund:
        """Inserts the row now (flush), so a second row under the key surfaces here."""
        self._session.add(refund)
        await self._session.flush()
        return refund

    async def start_attempt(self, refund_id: uuid.UUID, now: datetime) -> int | None:
        """Stamps a Stripe attempt starting at `now` and returns its number: pending, no error
        code, one more attempt. None (nothing written) once Stripe made the refund. The caller
        holds the row's lock and commits before the Stripe call."""
        statement = (
            update(Refund)
            .where(Refund.id == refund_id, Refund.status.in_(REFUND_NOT_MADE))
            .values(
                status=RefundStatus.PENDING,
                last_error_code=None,
                last_error_definitive=False,
                requested_at=now,
                attempts=Refund.attempts + 1,
            )
            .returning(Refund.attempts)
        )
        return await self._session.scalar(statement)

    async def mark_failed(
        self, refund_id: uuid.UUID, attempt: int, code: str, *, definitive: bool = False
    ) -> bool:
        """Ends attempt number `attempt` as failed with `code`, `definitive` when it was
        Stripe's definitive answer to the create. False (nothing written) when a later attempt
        started meanwhile or the refund was stored."""
        statement = (
            update(Refund)
            .where(
                Refund.id == refund_id,
                Refund.attempts == attempt,
                Refund.status == RefundStatus.PENDING,
                Refund.stripe_refund_id.is_(None),
            )
            .values(
                status=RefundStatus.FAILED, last_error_code=code, last_error_definitive=definitive
            )
            .returning(Refund.id)
        )
        return (await self._session.scalar(statement)) is not None

    async def observe(
        self, refund_id: uuid.UUID, stripe_refund_id: str, stripe_status: str
    ) -> bool:
        """Stores the refund Stripe holds for the row (created, its id) and Stripe's status of
        it now. False (nothing written) when the row holds another Stripe refund, or a status
        more final than this one (stripe_status_rank: the read is older). The caller holds the
        row's lock and commits it with what the status settles, if anything."""
        stored_rank = case(
            (Refund.stripe_status.is_(None), STRIPE_RANK_NONE),
            (Refund.stripe_status == STRIPE_REFUND_SUCCEEDED, STRIPE_RANK_SUCCEEDED),
            (Refund.stripe_status.in_(STRIPE_REFUND_DEAD), STRIPE_RANK_DEAD),
            else_=STRIPE_RANK_UNFINISHED,
        )
        statement = (
            update(Refund)
            .where(
                Refund.id == refund_id,
                Refund.stripe_refund_id.is_(None) | (Refund.stripe_refund_id == stripe_refund_id),
                stored_rank <= stripe_status_rank(stripe_status),
            )
            .values(
                status=RefundStatus.CREATED,
                stripe_refund_id=stripe_refund_id,
                stripe_status=stripe_status,
                last_error_code=None,
            )
            .returning(Refund.id)
        )
        return (await self._session.scalar(statement)) is not None

    async def by_stripe_id(self, stripe_refund_id: str) -> Refund | None:
        """The row holding this Stripe refund, unlocked, read as last committed."""
        statement = (
            select(Refund)
            .where(Refund.stripe_refund_id == stripe_refund_id)
            .execution_options(populate_existing=True)
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def dead_of_disputes(self, dispute_ids: Collection[uuid.UUID]) -> set[uuid.UUID]:
        """The disputes among these whose refund (not abandoned) Stripe failed or canceled."""
        if not dispute_ids:
            return set()
        statement = select(Refund.dispute_id).where(
            Refund.dispute_id.in_(dispute_ids),
            Refund.stripe_status.in_(STRIPE_REFUND_DEAD),
            Refund.status != RefundStatus.ABANDONED,
        )
        return {dispute_id for dispute_id in await self._session.scalars(statement) if dispute_id}

    async def hold_for_reconciliation(self, dispute_id: uuid.UUID, now: datetime) -> int:
        """Marks the dispute's abandoned and failed refunds as seen made late (#450 round 2):
        the first time is kept, so a repeated event changes nothing. Returns how many rows hold
        it now. The caller holds the job's and the dispute's locks; the rows' are taken here."""
        statement = (
            update(Refund)
            .where(
                Refund.dispute_id == dispute_id,
                Refund.status.in_((RefundStatus.ABANDONED, RefundStatus.FAILED)),
            )
            .values(late_refund_seen_at=func.coalesce(Refund.late_refund_seen_at, now))
            .returning(Refund.id)
        )
        return len((await self._session.scalars(statement)).all())

    async def held_for_reconciliation(self, dispute_ids: Collection[uuid.UUID]) -> set[uuid.UUID]:
        """The disputes among these with a refund staff must reconcile (late_refund_seen_at)."""
        if not dispute_ids:
            return set()
        statement = select(Refund.dispute_id).where(
            Refund.dispute_id.in_(dispute_ids), Refund.late_refund_seen_at.is_not(None)
        )
        return {dispute_id for dispute_id in await self._session.scalars(statement) if dispute_id}

    async def unsettled_of_job(self, job_id: uuid.UUID) -> bool:
        """Whether the job has a dispute refund Stripe has not finished (not `succeeded`)."""
        statement = select(
            RefundRepository.unsettled_dispute_jobs().where(Refund.job_id == job_id).exists()
        )
        return bool(await self._session.scalar(statement))

    @staticmethod
    def unsettled_dispute_jobs() -> Select[uuid.UUID]:
        """The job of every dispute refund whose money Stripe has not given back (anything but
        `succeeded`, none read yet included): its payout stays held (payments.transfers). An
        abandoned refund holds nothing: Stripe showed none that could still move money (#434),
        unless a refund was seen made late for its dispute since (late_refund_seen_at, #450
        round 2): then it holds the payout until staff reconcile it, whatever its status."""
        return select(Refund.job_id.label("job_id")).where(
            Refund.dispute_id.is_not(None),
            or_(
                and_(
                    Refund.stripe_status.is_distinct_from(STRIPE_REFUND_SUCCEEDED),
                    Refund.status != RefundStatus.ABANDONED,
                ),
                Refund.late_refund_seen_at.is_not(None),
            ),
        )
