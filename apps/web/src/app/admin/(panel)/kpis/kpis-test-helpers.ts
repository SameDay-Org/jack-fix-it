/** Fixtures of the KPI page tests: `GET /v1/admin/metrics` as the API answers it. Tests only. */
import type { MetricsOut } from "./kpis";

type Metrics = MetricsOut["metrics"];

/** Three days with some of everything, revenue net of refunds as the API answers it. */
export function metrics(
  extra: Partial<Omit<MetricsOut, "metrics">> & { metrics?: Partial<Metrics> } = {},
): MetricsOut {
  const { metrics: figures, ...rest } = extra;
  return {
    from_date: "2026-11-16",
    to_date: "2026-11-18",
    time_zone: "America/New_York",
    refunds_netted: true,
    series: [
      { day: "2026-11-16", requests_created: 14, jobs_completed: 3, gmv_cents: 48_000 },
      { day: "2026-11-17", requests_created: 12, jobs_completed: 5, gmv_cents: 61_250 },
      { day: "2026-11-18", requests_created: 14, jobs_completed: 4, gmv_cents: 0 },
    ],
    ...rest,
    metrics: {
      avg_first_response_minutes: {
        formula: "first_response_minutes",
        value: 65.4,
        median: 12.2,
        denominator: 31,
      },
      contact_rate: { formula: "contact_rate", value: 0.775, numerator: 31, denominator: 40 },
      lead_to_job: { formula: "lead_to_job", value: 0.3, numerator: 12, denominator: 40 },
      completion_rate: {
        formula: "completion_rate",
        value: 0.6667,
        numerator: 8,
        denominator: 12,
      },
      customer_rating_avg: { formula: "customer_rating", value: 4.8, denominator: 6 },
      pro_rating_avg: { formula: "pro_rating", value: 4.62, denominator: 9 },
      dispute_rate: { formula: "dispute_rate", value: 0.0833, numerator: 1, denominator: 12 },
      repeat_rate: { formula: "repeat_rate", value: 0.25, numerator: 2, denominator: 8 },
      gmv_cents: { formula: "gmv", value: 109_250 },
      revenue_cents: { formula: "revenue_net_of_refunds", value: 16_388 },
      ...figures,
    },
  };
}

/** A range in which nothing happened: every count 0, every average and ratio null. */
export function emptyMetrics(): MetricsOut {
  const ratio = (formula: Metrics["contact_rate"]["formula"]) => ({
    formula,
    value: null,
    numerator: 0,
    denominator: 0,
  });
  return metrics({
    series: [
      { day: "2026-11-17", requests_created: 0, jobs_completed: 0, gmv_cents: 0 },
      { day: "2026-11-18", requests_created: 0, jobs_completed: 0, gmv_cents: 0 },
    ],
    metrics: {
      avg_first_response_minutes: {
        formula: "first_response_minutes",
        value: null,
        median: null,
        denominator: 0,
      },
      contact_rate: ratio("contact_rate"),
      lead_to_job: ratio("lead_to_job"),
      completion_rate: ratio("completion_rate"),
      customer_rating_avg: { formula: "customer_rating", value: null, denominator: 0 },
      pro_rating_avg: { formula: "pro_rating", value: null, denominator: 0 },
      dispute_rate: ratio("dispute_rate"),
      repeat_rate: ratio("repeat_rate"),
      gmv_cents: { formula: "gmv", value: 0 },
      revenue_cents: { formula: "revenue_net_of_refunds", value: 0 },
    },
  });
}
