/**
 * The KPI page's settings, mirrored from the API's (server side only). Both are optional: a
 * variable missing on the web service, or one that cannot be read, falls back to the API's own
 * default, so it never breaks the page.
 */

/** The API's default BUSINESS_TIME_ZONE (apps/api/app/config.py, `business_time_zone`). */
export const DEFAULT_BUSINESS_TIME_ZONE = "America/New_York";

/** The API's default METRICS_MAX_RANGE_DAYS (apps/api/app/config.py, `metrics_max_range_days`). */
export const DEFAULT_METRICS_MAX_RANGE_DAYS = 366;

/** BUSINESS_TIME_ZONE when it names an IANA zone, else the API's default. */
export function businessTimeZone(): string {
  const zone = process.env.BUSINESS_TIME_ZONE ?? "";
  if (!zone) return DEFAULT_BUSINESS_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_BUSINESS_TIME_ZONE;
  }
}

/** METRICS_MAX_RANGE_DAYS when it is a positive whole number, else the API's default. */
export function metricsMaxRangeDays(): number {
  const days = Number(process.env.METRICS_MAX_RANGE_DAYS);
  return Number.isInteger(days) && days > 0 ? days : DEFAULT_METRICS_MAX_RANGE_DAYS;
}
