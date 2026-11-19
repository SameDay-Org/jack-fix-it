"""The metrics' one statement (#84): every figure of a range in a single SELECT.

Postgres evaluates one statement on one snapshot, whatever the isolation level, so the figures
agree with each other (a job counted completed is in its rate's denominator too). The tables
are read through the subqueries their own modules expose (ADR 0003): this module imports no
other module's models.

Time zones are Postgres's (its own tz database, as the operations queue reads them): the range
is [timezone(tz, first::timestamp), timezone(tz, (last + 1)::timestamp)), so a day of a
daylight-saving change is 23 or 25 hours long.
"""

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Final

from sqlalchemy import (
    JSON,
    TIMESTAMP,
    ColumnElement,
    Date,
    ScalarSelect,
    Subquery,
    and_,
    case,
    cast,
    func,
    literal_column,
    select,
)
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

# Postgres's answer to a time zone it does not know (invalid_parameter_value).
_UNKNOWN_ZONE: Final = "22023"


@dataclass(frozen=True)
class Sources:
    """The other modules' subqueries (their service functions *_metric_facts)."""

    requests: Subquery
    jobs: Subquery
    reviews: Subquery
    disputes: Subquery


@dataclass(frozen=True)
class Snapshot:
    """The raw figures of one range, as the statement returns them."""

    requests_created: int
    requests_contacted: int
    response_mean_seconds: float | None
    response_median_seconds: float | None
    requests_with_job: int
    jobs_created: int
    jobs_created_completed: int
    jobs_completed: int
    disputes_opened: int
    pro_rating_mean: float | None
    pro_ratings: int
    customer_rating_mean: float | None
    customer_ratings: int
    repeat_customers: int
    customers_confirmed: int
    gmv_cents: int
    revenue_cents: int
    # Per day (an ISO date in the time zone) -> the day's figure; days with none are absent.
    requests_by_day: dict[str, int]
    completions_by_day: dict[str, int]
    gmv_by_day: dict[str, int]


def _within(
    column: ColumnElement[Any], start: ColumnElement[Any], end: ColumnElement[Any]
) -> ColumnElement[bool]:
    """In the range: from its start, inclusive, to its end, exclusive."""
    return and_(column >= start, column < end)


def _count(source: Subquery, *where: ColumnElement[bool]) -> ScalarSelect[int]:
    return select(func.count()).select_from(source).where(*where).scalar_subquery()


def _by_day(
    source: Subquery,
    moment: ColumnElement[Any],
    figure: ColumnElement[Any],
    time_zone: str,
    *where: ColumnElement[bool],
) -> ScalarSelect[Any]:
    """{day in `time_zone`: figure} over the rows of `where`, as one JSON object."""
    day = func.date(func.timezone(time_zone, moment)).label("day")
    per_day = (
        select(day, figure.label("figure"))
        .select_from(source)
        .where(*where)
        # By the output column's name: the time zone is a bound parameter, and Postgres would
        # not match the same expression bound twice.
        .group_by(literal_column("day"))
        .subquery()
    )
    return select(
        func.json_object_agg(per_day.c.day, per_day.c.figure, type_=JSON)
    ).scalar_subquery()


class MetricsRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def today(self, time_zone: str, now: datetime) -> date | None:
        """The day `now` falls on in `time_zone`; None when Postgres knows no such zone (the
        transaction is then rolled back). Reads no table."""
        try:
            return await self._session.scalar(select(cast(func.timezone(time_zone, now), Date)))
        except DBAPIError as error:
            if getattr(error.orig, "sqlstate", None) != _UNKNOWN_ZONE:
                raise
            await self._session.rollback()
            return None

    async def snapshot(self, sources: Sources, first: date, last: date, time_zone: str) -> Snapshot:
        """Every figure of the days `first` to `last` (inclusive) in `time_zone`, in one
        statement."""
        start = func.timezone(time_zone, cast(first, TIMESTAMP))
        end = func.timezone(time_zone, cast(last + timedelta(days=1), TIMESTAMP))
        requests, jobs, reviews, disputes = (
            sources.requests,
            sources.jobs,
            sources.reviews,
            sources.disputes,
        )
        created = _within(requests.c.created_at, start, end)
        contacted = and_(created, requests.c.first_contact_at.is_not(None))
        response = func.extract("epoch", requests.c.first_contact_at - requests.c.created_at)
        job_created = _within(jobs.c.created_at, start, end)
        job_completed = _within(jobs.c.completed_at, start, end)
        job_confirmed = _within(jobs.c.confirmed_at, start, end)
        confirmed_customers = select(jobs.c.customer_id).where(job_confirmed).distinct().subquery()
        repeaters = (
            select(jobs.c.customer_id)
            .where(
                jobs.c.confirmed_at < end,
                jobs.c.customer_id.in_(select(confirmed_customers.c.customer_id)),
            )
            .group_by(jobs.c.customer_id)
            .having(func.count() >= 2)
            .subquery()
        )

        def rating(about_pro: bool) -> tuple[ScalarSelect[Any], ScalarSelect[int]]:
            where = (_within(reviews.c.created_at, start, end), reviews.c.about_pro.is_(about_pro))
            return (
                select(func.avg(reviews.c.overall)).where(*where).scalar_subquery(),
                _count(reviews, *where),
            )

        # What the platform keeps on a dispute resolved in the range (#76's split, as the
        # settlement stored it): a release keeps the job's fee, a full refund keeps nothing, a
        # partial keeps what is left of the customer's total once the pro's part and the
        # refund are taken out. A disputed job is never confirmed (the state machine has no
        # such path), and a job counted as confirmed is never counted here again.
        kept = case(
            (disputes.c.released_in_full, jobs.c.platform_fee_cents),
            (disputes.c.refunded_in_full, 0),
            else_=jobs.c.captured_cents
            - disputes.c.pro_release_cents
            - disputes.c.customer_refund_cents,
        )
        dispute_settled = and_(
            _within(disputes.c.resolved_at, start, end), jobs.c.confirmed_at.is_(None)
        )

        pro_mean, pro_count = rating(True)
        customer_mean, customer_count = rating(False)
        statement = select(
            _count(requests, created).label("requests_created"),
            _count(requests, contacted).label("requests_contacted"),
            select(func.avg(response)).where(contacted).scalar_subquery().label("response_mean"),
            select(func.percentile_cont(0.5).within_group(response))
            .where(contacted)
            .scalar_subquery()
            .label("response_median"),
            select(func.count())
            .select_from(requests.join(jobs, jobs.c.request_id == requests.c.request_id))
            .where(created)
            .scalar_subquery()
            .label("requests_with_job"),
            _count(jobs, job_created).label("jobs_created"),
            _count(jobs, job_created, jobs.c.completed_at.is_not(None)).label(
                "jobs_created_completed"
            ),
            _count(jobs, job_completed).label("jobs_completed"),
            _count(disputes, _within(disputes.c.created_at, start, end)).label("disputes_opened"),
            pro_mean.label("pro_rating_mean"),
            pro_count.label("pro_ratings"),
            customer_mean.label("customer_rating_mean"),
            customer_count.label("customer_ratings"),
            select(func.count()).select_from(repeaters).scalar_subquery().label("repeaters"),
            select(func.count())
            .select_from(confirmed_customers)
            .scalar_subquery()
            .label("customers_confirmed"),
            select(func.coalesce(func.sum(jobs.c.captured_cents), 0))
            .where(job_confirmed)
            .scalar_subquery()
            .label("gmv"),
            select(func.coalesce(func.sum(jobs.c.platform_fee_cents), 0))
            .where(job_confirmed)
            .scalar_subquery()
            .label("revenue"),
            select(func.coalesce(func.sum(kept), 0))
            .select_from(disputes.join(jobs, jobs.c.job_id == disputes.c.job_id))
            .where(dispute_settled)
            .scalar_subquery()
            .label("dispute_revenue"),
            _by_day(requests, requests.c.created_at, func.count(), time_zone, created).label(
                "requests_by_day"
            ),
            _by_day(jobs, jobs.c.completed_at, func.count(), time_zone, job_completed).label(
                "completions_by_day"
            ),
            _by_day(
                jobs, jobs.c.confirmed_at, func.sum(jobs.c.captured_cents), time_zone, job_confirmed
            ).label("gmv_by_day"),
        )
        row = (await self._session.execute(statement)).one()
        return Snapshot(
            requests_created=row.requests_created,
            requests_contacted=row.requests_contacted,
            response_mean_seconds=_float(row.response_mean),
            response_median_seconds=_float(row.response_median),
            requests_with_job=row.requests_with_job,
            jobs_created=row.jobs_created,
            jobs_created_completed=row.jobs_created_completed,
            jobs_completed=row.jobs_completed,
            disputes_opened=row.disputes_opened,
            pro_rating_mean=_float(row.pro_rating_mean),
            pro_ratings=row.pro_ratings,
            customer_rating_mean=_float(row.customer_rating_mean),
            customer_ratings=row.customer_ratings,
            repeat_customers=row.repeaters,
            customers_confirmed=row.customers_confirmed,
            gmv_cents=int(row.gmv),
            revenue_cents=int(row.revenue) + int(row.dispute_revenue),
            requests_by_day=_days(row.requests_by_day),
            completions_by_day=_days(row.completions_by_day),
            gmv_by_day=_days(row.gmv_by_day),
        )


def _float(value: Decimal | float | None) -> float | None:
    return None if value is None else float(value)


def _days(value: dict[str, Any] | None) -> dict[str, int]:
    """json_object_agg over no row is NULL: no day."""
    return {} if value is None else {day: int(figure) for day, figure in value.items()}
