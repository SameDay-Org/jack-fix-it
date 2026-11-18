/**
 * The KPI page's date range (#84): whole days, both ends inclusive, as `GET /v1/admin/metrics`
 * reads them. Plain functions over `YYYY-MM-DD` strings, shared by the page (server) and the
 * range control (browser), so both judge a range the way the API does.
 */

export const KPIS_PATH = "/admin/kpis";

/** The preset ranges, in days ending today. Without one in the URL the API picks its default. */
export const RANGE_PRESETS = [7, 30, 90] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

/** What the URL asks for: the API's default range, a preset, or two days. */
export type RangeQuery =
  | { kind: "default" }
  | { kind: "preset"; days: RangePreset }
  | { kind: "custom"; from: string; to: string };

/** Why a range cannot be read, before the API is asked. */
export type RangeError = "missing" | "order" | "length";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function utcMs(day: string): number {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, date);
}

/** A real calendar day written `YYYY-MM-DD` (not 2026-02-30). */
export function isIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  return new Date(utcMs(value)).toISOString().slice(0, 10) === value;
}

export function addDays(day: string, days: number): string {
  return new Date(utcMs(day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The number of days from `from` to `to`, both included. */
export function spanDays(from: string, to: string): number {
  return Math.round((utcMs(to) - utcMs(from)) / DAY_MS) + 1;
}

/** Today's date in a time zone, `YYYY-MM-DD`. */
export function todayIn(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The API's own checks on a range: two real days, in order, at most `maxDays` long. */
export function rangeError(from: string, to: string, maxDays: number): RangeError | null {
  if (!isIsoDay(from) || !isIsoDay(to)) return "missing";
  if (from > to) return "order";
  if (spanDays(from, to) > maxDays) return "length";
  return null;
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isPreset(value: number): value is RangePreset {
  return RANGE_PRESETS.some((preset) => preset === value);
}

/**
 * The range in the URL: `?from=&to=` (both, as typed: checked later), else `?days=` when it is
 * a preset, else the API's default. Anything else in `days` is ignored.
 */
export function toRangeQuery(query: Record<string, string | string[] | undefined>): RangeQuery {
  const from = single(query.from);
  const to = single(query.to);
  if (from !== undefined || to !== undefined) {
    return { kind: "custom", from: from ?? "", to: to ?? "" };
  }
  const days = Number(single(query.days));
  return isPreset(days) ? { kind: "preset", days } : { kind: "default" };
}

/** The first and last day a preset reads, ending `today`. */
export function presetDays(days: RangePreset, today: string): { from: string; to: string } {
  return { from: addDays(today, -(days - 1)), to: today };
}

/** The page's address for a range: shareable, the range in the query. */
export function rangeHref(range: RangeQuery): string {
  if (range.kind === "default") return KPIS_PATH;
  const query =
    range.kind === "preset"
      ? new URLSearchParams({ days: String(range.days) })
      : new URLSearchParams({ from: range.from, to: range.to });
  return `${KPIS_PATH}?${query.toString()}`;
}

/** The preset a range is, when it ends `today` and has a preset's length. */
export function presetOf(from: string, to: string, today: string): RangePreset | null {
  if (to !== today) return null;
  const days = spanDays(from, to);
  return isPreset(days) ? days : null;
}
