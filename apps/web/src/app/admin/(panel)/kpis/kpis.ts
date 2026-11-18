import type { components } from "@jack/shared";
import type { TFunction } from "i18next";

import { formatUsd } from "../queue/queue";

/** The dashboard's figures as `GET /v1/admin/metrics` returns them (#84, docs/kpis.md). */
export type MetricsOut = components["schemas"]["MetricsOut"];
export type MetricFormula = components["schemas"]["MetricFormula"];
export type SeriesPoint = components["schemas"]["SeriesPoint"];
type RatioMetric = components["schemas"]["RatioMetric"];
type RatingMetric = components["schemas"]["RatingMetric"];

/** A figure as a card shows it: its value and the lines under it, or no value at all. */
export type Figure = { value: string; details: string[] } | null;

export type CardKey =
  | "firstResponse"
  | "contactRate"
  | "leadToJob"
  | "completionRate"
  | "customerRating"
  | "proRating"
  | "disputeRate"
  | "repeatRate"
  | "gmv"
  | "revenue";

export type MetricCard = {
  key: CardKey;
  title: string;
  description: string;
  formula: MetricFormula;
  figure: Figure;
  /** Revenue before refunds: a label and a line saying so (`refunds_netted` false). */
  beforeRefunds?: boolean;
};

/** The parts of a duration in whole minutes: under one minute, or hours and minutes. */
export function durationParts(minutes: number): { hours: number; minutes: number } | null {
  const total = Math.round(minutes);
  if (total < 1) return null;
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/** "12 min", "1 h 05 min", "< 1 min". */
export function formatDuration(minutes: number, t: TFunction): string {
  const parts = durationParts(minutes);
  if (parts === null) return t("admin.kpis.duration.underMinute");
  if (parts.hours === 0) return t("admin.kpis.duration.minutes", { minutes: parts.minutes });
  return t("admin.kpis.duration.hours", {
    hours: parts.hours,
    minutes: String(parts.minutes).padStart(2, "0"),
  });
}

/** A share as a percentage, one decimal at most: "37%", "2.5%". */
export function formatPercent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** A 1 to 5 rating as the API rounds it (2 decimals), at least one shown: "4.5", "4.62". */
export function formatRating(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  }).format(value);
}

function ratio(metric: RatioMetric, locale: string, t: TFunction): Figure {
  if (metric.value === null) return null;
  return {
    value: formatPercent(metric.value, locale),
    details: [
      t("admin.kpis.ofTotal", {
        numerator: formatCount(metric.numerator, locale),
        denominator: formatCount(metric.denominator, locale),
      }),
    ],
  };
}

function rating(metric: RatingMetric, locale: string, t: TFunction): Figure {
  if (metric.value === null) return null;
  return {
    value: formatRating(metric.value, locale),
    details: [
      t("admin.kpis.outOfFive"),
      t("admin.kpis.reviewsCounted", { count: formatCount(metric.denominator, locale) }),
    ],
  };
}

/** The ten cards, in the plan's order. A figure the API gives as null has no value. */
export function metricCards(data: MetricsOut, locale: string, t: TFunction): MetricCard[] {
  const m = data.metrics;
  const response = m.avg_first_response_minutes;
  const card = (key: CardKey, formula: MetricFormula, figure: Figure): MetricCard => ({
    key,
    title: t(`admin.kpis.cards.${key}.title`),
    description: t(`admin.kpis.cards.${key}.description`),
    formula,
    figure,
  });
  return [
    card(
      "firstResponse",
      response.formula,
      response.value === null
        ? null
        : {
            value: formatDuration(response.value, t),
            details: [
              ...(response.median === null
                ? []
                : [t("admin.kpis.median", { value: formatDuration(response.median, t) })]),
              t("admin.kpis.requestsCounted", { count: formatCount(response.denominator, locale) }),
            ],
          },
    ),
    card("contactRate", m.contact_rate.formula, ratio(m.contact_rate, locale, t)),
    card("leadToJob", m.lead_to_job.formula, ratio(m.lead_to_job, locale, t)),
    card("completionRate", m.completion_rate.formula, ratio(m.completion_rate, locale, t)),
    card("customerRating", m.customer_rating_avg.formula, rating(m.customer_rating_avg, locale, t)),
    card("proRating", m.pro_rating_avg.formula, rating(m.pro_rating_avg, locale, t)),
    card("disputeRate", m.dispute_rate.formula, ratio(m.dispute_rate, locale, t)),
    card("repeatRate", m.repeat_rate.formula, ratio(m.repeat_rate, locale, t)),
    card("gmv", m.gmv_cents.formula, {
      value: formatUsd(m.gmv_cents.value, locale),
      details: [],
    }),
    {
      ...card("revenue", m.revenue_cents.formula, {
        value: formatUsd(m.revenue_cents.value, locale),
        details: [],
      }),
      beforeRefunds: !data.refunds_netted,
    },
  ];
}

/** Nothing happened in the range: no request, job, review, dispute or payment. */
export function isEmpty(data: MetricsOut): boolean {
  const m = data.metrics;
  const counted = [
    m.avg_first_response_minutes.denominator,
    m.contact_rate.denominator,
    m.lead_to_job.denominator,
    m.completion_rate.denominator,
    m.customer_rating_avg.denominator,
    m.pro_rating_avg.denominator,
    m.dispute_rate.numerator,
    m.dispute_rate.denominator,
    m.repeat_rate.denominator,
    m.gmv_cents.value,
    m.revenue_cents.value,
  ];
  const daily = data.series.flatMap((point) => [
    point.requests_created,
    point.jobs_completed,
    point.gmv_cents,
  ]);
  return [...counted, ...daily].every((value) => value === 0);
}
