"""The MVP exit metrics for the admin dashboard (#84, D16.5): staff only, read only.

The range is whole days in a time zone (BUSINESS_TIME_ZONE unless `tz` names another IANA
zone), both ends inclusive: from local midnight of `from` to local midnight after `to`, so a
day of a daylight-saving change is 23 or 25 hours long. Default: the METRICS_DEFAULT_RANGE_DAYS
days ending today; at most METRICS_MAX_RANGE_DAYS. "In the range" below means the timestamp
named falls in it.

1. avg_first_response_minutes: over the requests created in the range that have a first
   contact (first_contact_at, #81), the mean and the median of first_contact_at - created_at.
   Denominator: those requests.
2. contact_rate: requests created in the range with a first contact (at any time since) /
   requests created in the range.
3. lead_to_job: requests created in the range that have a job (any status) / requests created
   in the range.
4. completion_rate: jobs created in the range (jobs.created_at: paid and scheduled) that reached
   completed (completed_at set: confirmed, paid out, disputed and refunded jobs all passed
   through completed) / jobs created in the range. A job cancelled before it started stays in
   the denominator.
5. customer_rating_avg / pro_rating_avg: the mean overall rating of the reviews created in the
   range that rate a customer (written by the pro) / a pro (written by the customer), published
   or not; null with none, never 0.
6. dispute_rate: disputes opened in the range / jobs completed in the range (completed_at).
7. repeat_rate: among the customers with at least one job confirmed in the range
   (confirmed_at), those with at least two jobs confirmed before the range's end.
8. gmv_cents: what the customers were charged (the frozen price plus the tax) for the jobs
   confirmed in the range; gross, and those jobs only. revenue_cents, net of refunds
   (`refunds_netted` true): the fee the platform keeps, on two cohorts that never share a job
   (a disputed job is never confirmed, and the query counts a confirmed one once):
   - the jobs confirmed in the range: their fee, as charged (frozen at payment);
   - the disputes an admin resolved in the range (resolved_at; a refund's dispute resolves
     only once Stripe gave the money back, #76): a release keeps the job's fee; a full refund
     keeps nothing; a partial keeps what #76's split left the platform, the customer's total
     minus the pro's part and the refund, as the settlement stored them (app.money
     .partial_refund_cents made the refund; nothing is recomputed here). Tax is 0 in the MVP
     (payments TAX_CENTS), so that is the fee; once tax is charged, its share must come out.
   GMV and revenue cover different jobs on purpose: GMV is what customers paid for confirmed
   work, revenue what the platform earned. Tips are the pro's in full, so neither figure would
   include them (none exist yet).
series: per day of the range, the requests created, the jobs completed and the GMV of the jobs
confirmed that day.

Every figure comes from one SELECT, on one snapshot (repository.py), and every division with a
denominator of 0 is null. The answer holds aggregates only: no name, contact, address or id.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.disputes.service import dispute_metric_facts
from app.modules.jobs.service import job_metric_facts
from app.modules.metrics.errors import InvalidRangeError
from app.modules.metrics.repository import MetricsRepository, Snapshot, Sources
from app.modules.metrics.schemas import (
    AmountMetric,
    MetricFormula,
    Metrics,
    MetricsOut,
    RatingMetric,
    RatioMetric,
    ResponseTimeMetric,
    SeriesPoint,
)
from app.modules.requests.service import request_metric_facts
from app.modules.reviews.service import review_metric_facts


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class MetricsConfig:
    time_zone: str
    default_days: int
    max_days: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "MetricsConfig":
        return cls(
            time_zone=settings.business_time_zone,
            default_days=settings.metrics_default_range_days,
            max_days=settings.metrics_max_range_days,
        )


@dataclass(frozen=True)
class DayRange:
    """Whole days in `time_zone`, both inclusive."""

    first: date
    last: date
    time_zone: str

    def days(self) -> list[date]:
        return [self.first + timedelta(days=n) for n in range((self.last - self.first).days + 1)]


def day_range(
    config: MetricsConfig, today: date, first: date | None, last: date | None, time_zone: str
) -> DayRange:
    """The range asked for, or the default one ending `today` (in `time_zone`);
    InvalidRangeError for one the metrics do not read."""
    last = last or today
    first = first or last - timedelta(days=config.default_days - 1)
    if first > last or (last - first).days + 1 > config.max_days:
        raise InvalidRangeError
    return DayRange(first=first, last=last, time_zone=time_zone)


class MetricsService:
    def __init__(
        self,
        session: AsyncSession,
        config: MetricsConfig,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._session = session
        self._config = config
        self._clock = clock
        self._metrics = MetricsRepository(session)

    async def read(
        self, first: date | None, last: date | None, time_zone: str | None
    ) -> MetricsOut:
        """The metrics of the range (see the module doc). Ends its transaction."""
        zone = time_zone or self._config.time_zone
        today = await self._metrics.today(zone, self._clock())
        if today is None:
            raise InvalidRangeError
        days = day_range(self._config, today, first, last, zone)
        sources = Sources(
            requests=request_metric_facts(),
            jobs=job_metric_facts(),
            reviews=review_metric_facts(),
            disputes=dispute_metric_facts(),
        )
        snapshot = await self._metrics.snapshot(sources, days.first, days.last, days.time_zone)
        await self._session.rollback()
        return MetricsOut(
            from_date=days.first,
            to_date=days.last,
            time_zone=days.time_zone,
            refunds_netted=True,
            metrics=_metrics(snapshot),
            series=[
                SeriesPoint(
                    day=day,
                    requests_created=snapshot.requests_by_day.get(day.isoformat(), 0),
                    jobs_completed=snapshot.completions_by_day.get(day.isoformat(), 0),
                    gmv_cents=snapshot.gmv_by_day.get(day.isoformat(), 0),
                )
                for day in days.days()
            ],
        )


def _ratio(formula: MetricFormula, numerator: int, denominator: int) -> RatioMetric:
    value = None if denominator == 0 else round(numerator / denominator, 4)
    return RatioMetric(formula=formula, value=value, numerator=numerator, denominator=denominator)


def _minutes(seconds: float | None) -> float | None:
    return None if seconds is None else round(seconds / 60, 1)


def _rating(formula: MetricFormula, mean: float | None, count: int) -> RatingMetric:
    return RatingMetric(
        formula=formula, value=None if mean is None else round(mean, 2), denominator=count
    )


def _metrics(s: Snapshot) -> Metrics:
    return Metrics(
        avg_first_response_minutes=ResponseTimeMetric(
            formula=MetricFormula.FIRST_RESPONSE_MINUTES,
            value=_minutes(s.response_mean_seconds),
            median=_minutes(s.response_median_seconds),
            denominator=s.requests_contacted,
        ),
        contact_rate=_ratio(MetricFormula.CONTACT_RATE, s.requests_contacted, s.requests_created),
        lead_to_job=_ratio(MetricFormula.LEAD_TO_JOB, s.requests_with_job, s.requests_created),
        completion_rate=_ratio(
            MetricFormula.COMPLETION_RATE, s.jobs_created_completed, s.jobs_created
        ),
        customer_rating_avg=_rating(
            MetricFormula.CUSTOMER_RATING, s.customer_rating_mean, s.customer_ratings
        ),
        pro_rating_avg=_rating(MetricFormula.PRO_RATING, s.pro_rating_mean, s.pro_ratings),
        dispute_rate=_ratio(MetricFormula.DISPUTE_RATE, s.disputes_opened, s.jobs_completed),
        repeat_rate=_ratio(MetricFormula.REPEAT_RATE, s.repeat_customers, s.customers_confirmed),
        gmv_cents=AmountMetric(formula=MetricFormula.GMV, value=s.gmv_cents),
        revenue_cents=AmountMetric(
            formula=MetricFormula.REVENUE_NET_OF_REFUNDS, value=s.revenue_cents
        ),
    )
