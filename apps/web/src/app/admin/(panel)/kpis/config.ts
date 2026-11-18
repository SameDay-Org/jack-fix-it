/**
 * The KPI page's settings, mirrored from the API's (server side only, never a literal):
 * the business time zone the presets end "today" in, and the longest range the API reads.
 */

/** BUSINESS_TIME_ZONE: the API's, an IANA zone such as America/New_York. */
export function businessTimeZone(): string {
  const zone = process.env.BUSINESS_TIME_ZONE ?? "";
  const invalid = new Error("BUSINESS_TIME_ZONE is not set to an IANA time zone");
  if (!zone) throw invalid;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw invalid;
  }
  return zone;
}

/** METRICS_MAX_RANGE_DAYS: the API's longest range, in days. */
export function metricsMaxRangeDays(): number {
  const days = Number(process.env.METRICS_MAX_RANGE_DAYS);
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("METRICS_MAX_RANGE_DAYS is not set to a positive whole number");
  }
  return days;
}
