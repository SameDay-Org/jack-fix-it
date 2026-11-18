"""A pro's earning jobs, read through the subqueries their modules expose (ADR 0003): the jobs'
own facts (jobs), the transfer rows' state (payments; our rows, never a live Stripe call) and
the disputes an admin resolved with a release (disputes, #76).
"""

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final

from sqlalchemy import ColumnElement, Subquery, and_, case, func, literal_column, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.disputes.service import released_dispute_jobs
from app.modules.earnings.schemas import EarningStatus
from app.modules.jobs.service import JobStatus, job_earning_facts
from app.modules.payments.transfer_reader import transfer_payout_facts

# The jobs whose money the pro earned or may still earn: the work is done. Refunded and
# cancelled jobs pay nothing.
EARNING_JOB_STATUSES: Final = (
    JobStatus.COMPLETED,
    JobStatus.CONFIRMED,
    JobStatus.PAID_OUT,
    JobStatus.DISPUTED,
)


@dataclass(frozen=True)
class EarningRow:
    job_id: uuid.UUID
    request_id: uuid.UUID
    status: EarningStatus
    amount_cents: int
    completed_at: datetime
    paid_at: datetime | None


@dataclass(frozen=True)
class _Sources:
    jobs: Subquery
    transfers: Subquery
    # Disputes resolved with a release, full or partial (#76): job_id, pro_release_cents.
    released: Subquery

    def status(self) -> ColumnElement[str]:
        """The pro's status of a job, in order: an open dispute holds it whatever else; a job
        not confirmed yet waits for its customer; a transfer reversed by Stripe is under review;
        a made one is paid; anything else (confirmed, or disputed with the dispute released by
        an admin, the transfer to be made or retried) is on its way. A disputed job stays
        disputed until its transfer lands (#76)."""
        jobs, transfers = self.jobs, self.transfers
        return case(
            (
                and_(jobs.c.job_status == JobStatus.DISPUTED, self.released.c.job_id.is_(None)),
                EarningStatus.ON_HOLD.value,
            ),
            (jobs.c.job_status == JobStatus.COMPLETED, EarningStatus.AWAITING_CONFIRMATION.value),
            (transfers.c.reversed.is_(True), EarningStatus.ON_HOLD.value),
            (transfers.c.made.is_(True), EarningStatus.PAID.value),
            else_=EarningStatus.ON_THE_WAY.value,
        )

    def amount(self) -> ColumnElement[int]:
        """What the pro receives: the transfer's amount once a row exists; else the part an admin
        released of a disputed job (#76: all of the payout, or the part of a partial split);
        else the job's frozen payout (app.money.split_amount's, at payment). Never recomputed
        from a price."""
        return func.coalesce(
            self.transfers.c.amount_cents,
            self.released.c.pro_release_cents,
            self.jobs.c.pro_payout_cents,
        )

    def of_pro(self, pro_id: uuid.UUID) -> tuple[Any, ...]:
        return (
            self.jobs.c.pro_id == pro_id,
            self.jobs.c.job_status.in_(EARNING_JOB_STATUSES),
            # Set on entering completed, which every earning status passed through; the order
            # and the cursor read it.
            self.jobs.c.completed_at.is_not(None),
        )


def _sources() -> _Sources:
    return _Sources(
        jobs=job_earning_facts(),
        transfers=transfer_payout_facts(),
        released=released_dispute_jobs(),
    )


def _joined(s: _Sources) -> Any:
    """The jobs, with their transfer row and their released dispute when they have one."""
    return s.jobs.outerjoin(s.transfers, s.transfers.c.job_id == s.jobs.c.job_id).outerjoin(
        s.released, s.released.c.job_id == s.jobs.c.job_id
    )


class EarningsRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def totals(self, pro_id: uuid.UUID) -> dict[EarningStatus, int]:
        """The sum of each status over all the pro's earning jobs, in one statement."""
        s = _sources()
        statement = (
            select(s.status().label("status"), func.sum(s.amount()).label("cents"))
            .select_from(_joined(s))
            .where(*s.of_pro(pro_id))
            # By the output column's name: the CASE's values are bound parameters.
            .group_by(literal_column("status"))
        )
        rows = await self._session.execute(statement)
        return {EarningStatus(row.status): int(row.cents) for row in rows}

    async def page(
        self, pro_id: uuid.UUID, limit: int, before: tuple[datetime, uuid.UUID] | None
    ) -> list[EarningRow]:
        """Up to `limit` of the pro's earning jobs, newest completion first, then by job id;
        after `before` (the last row of the previous page) when given."""
        s = _sources()
        statement = (
            select(
                s.jobs.c.job_id,
                s.jobs.c.request_id,
                s.status().label("status"),
                s.amount().label("amount_cents"),
                s.jobs.c.completed_at,
                s.jobs.c.paid_out_at,
            )
            .select_from(_joined(s))
            .where(*s.of_pro(pro_id))
            .order_by(s.jobs.c.completed_at.desc(), s.jobs.c.job_id.desc())
            .limit(limit)
        )
        if before is not None:
            completed_at, job_id = before
            statement = statement.where(
                or_(
                    s.jobs.c.completed_at < completed_at,
                    and_(s.jobs.c.completed_at == completed_at, s.jobs.c.job_id < job_id),
                )
            )
        return [
            EarningRow(
                job_id=row.job_id,
                request_id=row.request_id,
                status=EarningStatus(row.status),
                amount_cents=row.amount_cents,
                completed_at=row.completed_at,
                paid_at=row.paid_out_at if row.status == EarningStatus.PAID.value else None,
            )
            for row in await self._session.execute(statement)
        ]
