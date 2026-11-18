import type { AgeLimits } from "./disputes";

/**
 * When a dispute's age turns amber, then red (server side only). Both are optional: a variable
 * missing on the web service, or one that cannot be read, falls back to its default, so it
 * never breaks the page.
 */
export const DEFAULT_DISPUTE_AGE_WARN_HOURS = 24;
export const DEFAULT_DISPUTE_AGE_LATE_HOURS = 48;

function hours(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * DISPUTE_AGE_WARN_HOURS and DISPUTE_AGE_LATE_HOURS, or 24 and 48. A red limit that does not
 * come after the amber one is ignored: the two defaults are used together.
 */
export function disputeAgeLimits(): AgeLimits {
  const warnHours = hours(process.env.DISPUTE_AGE_WARN_HOURS, DEFAULT_DISPUTE_AGE_WARN_HOURS);
  const lateHours = hours(process.env.DISPUTE_AGE_LATE_HOURS, DEFAULT_DISPUTE_AGE_LATE_HOURS);
  if (lateHours <= warnHours) {
    return {
      warnHours: DEFAULT_DISPUTE_AGE_WARN_HOURS,
      lateHours: DEFAULT_DISPUTE_AGE_LATE_HOURS,
    };
  }
  return { warnHours, lateHours };
}
