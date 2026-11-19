import type { TFunction } from "i18next";
import Link from "next/link";

import { Card, CardDescription } from "@/components/ui/card";
import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { ApiError, apiGet } from "@/lib/api";
import { requireStaff, staffAuth } from "@/lib/session";

import { formatUsd } from "../queue/queue";
import { businessTimeZone, metricsMaxRangeDays } from "./config";
import { formatCount, isEmpty, metricCards, type MetricsOut } from "./kpis";
import { MetricCards } from "./metric-cards";
import {
  isIsoDay,
  presetDays,
  presetOf,
  rangeError,
  rangeHref,
  type RangeQuery,
  todayIn,
  toRangeQuery,
} from "./range";
import { RangeControl, type RangeControlText } from "./range-control";
import { SeriesChart } from "./series-chart";

type Loaded = { data: MetricsOut } | "invalid" | "rate_limited" | "error";

const PILL_LINK =
  "inline-flex h-9 items-center rounded-pill bg-white px-4 text-sm font-semibold text-navy-900 shadow-sm outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2";

/** The days the API is asked for: none for its default range. */
function apiDays(range: RangeQuery, today: string): { from?: string; to?: string } {
  if (range.kind === "preset") return presetDays(range.days, today);
  if (range.kind === "custom") return { from: range.from, to: range.to };
  return {};
}

/** The figures, or why there are none: a range the API refuses, too many reads, an error. */
async function loadMetrics(
  auth: RequestInit,
  days: { from?: string; to?: string },
): Promise<Loaded> {
  try {
    return { data: await apiGet("/v1/admin/metrics", { ...auth, query: days }) };
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 422) return "invalid";
    if (failure instanceof ApiError && failure.status === 429) return "rate_limited";
    return "error";
  }
}

function controlText(t: TFunction, max: string): RangeControlText {
  return {
    label: t("admin.kpis.range.label"),
    presets: {
      7: t("admin.kpis.range.presets.7"),
      30: t("admin.kpis.range.presets.30"),
      90: t("admin.kpis.range.presets.90"),
    },
    custom: t("admin.kpis.range.custom"),
    from: t("admin.kpis.range.from"),
    to: t("admin.kpis.range.to"),
    apply: t("admin.kpis.range.apply"),
    updating: t("admin.kpis.range.updating"),
    errors: {
      missing: t("admin.kpis.range.errors.missing"),
      order: t("admin.kpis.range.errors.order"),
      length: t("admin.kpis.range.errors.length", { max }),
    },
  };
}

/** A calendar day as the reader writes it ("Nov 18, 2026"). */
function formatDay(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00Z`),
  );
}

/**
 * The KPI dashboard (#84) for agents and admins: the plan's exit metrics over a range of whole
 * days in the business time zone, from `GET /v1/admin/metrics`, read on the server with the
 * staff session. The range is in the URL; the figures are aggregates only.
 */
export default async function KpisPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireStaff();
  const locale = toLocale(user.locale);
  const t = await getT(locale);
  const maxDays = metricsMaxRangeDays();
  const today = todayIn(businessTimeZone(), new Date());
  const range = toRangeQuery(await searchParams);
  const days = apiDays(range, today);
  const refused = range.kind === "custom" && rangeError(range.from, range.to, maxDays) !== null;
  const loaded: Loaded = refused ? "invalid" : await loadMetrics(await staffAuth(), days);
  const data = typeof loaded === "object" ? loaded.data : null;
  const shown = data ? { from: data.from_date, to: data.to_date } : days;

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-navy-900">{t("admin.kpis.title")}</h1>
        <p className="text-sm text-gray-500">{t("admin.kpis.subtitle")}</p>
      </div>
      <RangeControl
        preset={
          range.kind === "preset"
            ? range.days
            : shown.from && shown.to
              ? presetOf(shown.from, shown.to, today)
              : null
        }
        from={shown.from && isIsoDay(shown.from) ? shown.from : ""}
        to={shown.to && isIsoDay(shown.to) ? shown.to : ""}
        today={today}
        maxDays={maxDays}
        text={controlText(t, formatCount(maxDays, locale))}
      />
      {data ? (
        <p className="text-sm text-gray-500">
          <span className="font-semibold text-navy-900">
            {t("admin.kpis.range.showing", {
              from: formatDay(data.from_date, locale),
              to: formatDay(data.to_date, locale),
            })}
          </span>{" "}
          {t("admin.kpis.range.timeZone", { zone: data.time_zone })}
        </p>
      ) : null}
      {loaded === "invalid" ? (
        <Card>
          <CardDescription className="text-navy-900">
            {t("admin.kpis.range.invalid", { max: formatCount(maxDays, locale) })}
          </CardDescription>
        </Card>
      ) : loaded === "error" || loaded === "rate_limited" ? (
        <Card role="alert" className="flex flex-col items-start gap-4">
          <p className="font-semibold text-danger">
            {loaded === "rate_limited" ? t("admin.kpis.rateLimited") : t("admin.kpis.loadError")}
          </p>
          <Link href={rangeHref(range)} className={PILL_LINK}>
            {t("admin.kpis.retry")}
          </Link>
        </Card>
      ) : data === null ? null : isEmpty(data) ? (
        <Card className="flex flex-col gap-1">
          <p className="font-semibold text-navy-900">{t("admin.kpis.empty")}</p>
          <CardDescription>{t("admin.kpis.emptyHint")}</CardDescription>
        </Card>
      ) : (
        <>
          <section aria-labelledby="kpi-figures" className="flex flex-col gap-4">
            <h2 id="kpi-figures" className="text-lg font-bold text-navy-900">
              {t("admin.kpis.figures")}
            </h2>
            <MetricCards cards={metricCards(data, locale, t)} t={t} />
          </section>
          <PerDay data={data} locale={locale} t={t} />
        </>
      )}
    </div>
  );
}

/** The series as two charts (counts, then money: never two scales on one axis) and a table. */
function PerDay({ data, locale, t }: { data: MetricsOut; locale: string; t: TFunction }) {
  const days = data.series.map((point) => point.day);
  const hint = t("admin.kpis.series.keyboardHint");
  const activity = t("admin.kpis.series.activity");
  const gmv = t("admin.kpis.series.gmv");
  return (
    <section aria-labelledby="kpi-per-day" className="flex flex-col gap-4">
      <h2 id="kpi-per-day" className="text-lg font-bold text-navy-900">
        {t("admin.kpis.series.title")}
      </h2>
      <Card className="flex flex-col gap-3 p-5">
        <h3 className="font-bold">{activity}</h3>
        <SeriesChart
          days={days}
          kind="count"
          locale={locale}
          label={activity}
          keyboardHint={hint}
          series={[
            {
              key: "requests",
              label: t("admin.kpis.series.requestsCreated"),
              color: "var(--color-navy-700)",
              values: data.series.map((point) => point.requests_created),
            },
            {
              key: "completed",
              label: t("admin.kpis.series.jobsCompleted"),
              color: "var(--color-green-700)",
              values: data.series.map((point) => point.jobs_completed),
            },
          ]}
        />
      </Card>
      <Card className="flex flex-col gap-3 p-5">
        <h3 className="font-bold">{gmv}</h3>
        <SeriesChart
          days={days}
          kind="money"
          locale={locale}
          label={gmv}
          keyboardHint={hint}
          area
          series={[
            {
              key: "gmv",
              label: t("admin.kpis.series.gmvShort"),
              color: "var(--color-navy-700)",
              values: data.series.map((point) => point.gmv_cents),
            },
          ]}
        />
      </Card>
      <details className="rounded-lg bg-white p-5 shadow-[0_8px_24px_rgb(1_23_46/0.08)]">
        <summary className="cursor-pointer rounded-sm font-semibold text-green-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2">
          {t("admin.kpis.series.showTable")}
        </summary>
        <div className="overflow-x-auto pt-4">
          <table className="w-full min-w-[28rem] text-left text-sm text-navy-900">
            <caption className="pb-2 text-left text-gray-500">
              {t("admin.kpis.series.tableCaption", {
                from: formatDay(data.from_date, locale),
                to: formatDay(data.to_date, locale),
              })}
            </caption>
            <thead>
              <tr className="border-b border-navy-900/10">
                <th scope="col" className="py-2 pr-4 font-semibold">
                  {t("admin.kpis.series.day")}
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-semibold">
                  {t("admin.kpis.series.requestsCreated")}
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-semibold">
                  {t("admin.kpis.series.jobsCompleted")}
                </th>
                <th scope="col" className="py-2 text-right font-semibold">
                  {t("admin.kpis.series.gmvShort")}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.series.map((point) => (
                <tr key={point.day} className="border-b border-navy-900/5">
                  <th scope="row" className="py-1.5 pr-4 font-normal">
                    {formatDay(point.day, locale)}
                  </th>
                  <td className="py-1.5 pr-4 text-right tabular-nums">
                    {formatCount(point.requests_created, locale)}
                  </td>
                  <td className="py-1.5 pr-4 text-right tabular-nums">
                    {formatCount(point.jobs_completed, locale)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {formatUsd(point.gmv_cents, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
