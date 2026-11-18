"""The staff metrics as the admin panel reads them (#84). Aggregates only: no name, contact,
address or id of anyone. Each figure names its formula (`formula`), whose text the panel prints
from its own translations; docs/kpis.md states each one."""

from datetime import date
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class MetricFormula(StrEnum):
    FIRST_RESPONSE_MINUTES = "first_response_minutes"
    CONTACT_RATE = "contact_rate"
    LEAD_TO_JOB = "lead_to_job"
    COMPLETION_RATE = "completion_rate"
    CUSTOMER_RATING = "customer_rating"
    PRO_RATING = "pro_rating"
    DISPUTE_RATE = "dispute_rate"
    REPEAT_RATE = "repeat_rate"
    GMV = "gmv"
    # Gross: refunds are not subtracted yet (they come with #76's refunds table); the key
    # changes when they are, so the panel never shows a gross figure under a net label.
    REVENUE_GROSS_OF_REFUNDS = "revenue_gross_of_refunds"


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RatioMetric(_Out):
    """`numerator` of `denominator`, so the panel can show "12 of 40"."""

    formula: MetricFormula
    value: float | None = Field(
        description="numerator / denominator, to 4 decimals; null when the denominator is 0."
    )
    numerator: int
    denominator: int


class ResponseTimeMetric(_Out):
    formula: MetricFormula
    value: float | None = Field(
        description="The mean, in minutes to 1 decimal; null when no request had a contact."
    )
    median: float | None = Field(description="The median, in minutes to 1 decimal.")
    denominator: int = Field(description="Requests of the range with a first contact.")


class RatingMetric(_Out):
    formula: MetricFormula
    value: float | None = Field(
        description="The mean overall rating (1 to 5), to 2 decimals; null with no review."
    )
    denominator: int = Field(description="Reviews counted.")


class AmountMetric(_Out):
    formula: MetricFormula
    value: int = Field(description="Integer cents (USD).")


class Metrics(_Out):
    avg_first_response_minutes: ResponseTimeMetric
    contact_rate: RatioMetric
    lead_to_job: RatioMetric
    completion_rate: RatioMetric
    customer_rating_avg: RatingMetric = Field(description="How pros rate their customers.")
    pro_rating_avg: RatingMetric = Field(description="How customers rate their pros.")
    dispute_rate: RatioMetric
    repeat_rate: RatioMetric
    gmv_cents: AmountMetric
    revenue_cents: AmountMetric


class SeriesPoint(_Out):
    day: date = Field(description="A day in `time_zone`.")
    requests_created: int
    jobs_completed: int
    gmv_cents: int


class MetricsOut(_Out):
    from_date: date = Field(description="The first day read, in `time_zone`.")
    to_date: date = Field(description="The last day read, in `time_zone` (inclusive).")
    time_zone: str = Field(examples=["America/New_York"])
    refunds_netted: bool = Field(
        description="Whether revenue_cents is net of refunds. False until #76's refunds land: "
        "revenue is then the platform's fee as charged."
    )
    metrics: Metrics
    series: list[SeriesPoint] = Field(description="One point per day of the range, in order.")
