import type { ApiSchema } from "@jack/shared";
import type { TFunction } from "i18next";

import { FACT_SEPARATOR, keepTogether } from "@/features/quotes/format";

/**
 * When in the preferred day the customer would like the visit (#237). It only refines a preferred
 * day: each pro still proposes the exact start in their quote.
 */
export type PreferredPeriod = ApiSchema<"PreferredPeriod">;

/** The period a picked day starts with, and the one that adds nothing to the day. */
export const FLEXIBLE_PERIOD: PreferredPeriod = "flexible";

/** The choices in the order of the day, flexible last. */
export const PREFERRED_PERIODS: readonly PreferredPeriod[] = [
  "morning",
  "afternoon",
  "evening",
  FLEXIBLE_PERIOD,
];

// Keyed by every period, so one the API adds fails the type check here first.
const LABEL_KEYS = {
  morning: "request.period.morning",
  afternoon: "request.period.afternoon",
  evening: "request.period.evening",
  flexible: "request.period.flexible",
} as const satisfies Record<PreferredPeriod, string>;

/** "Morning", "Tarde": the period's name in the app's language. */
export const periodLabel = (t: TFunction, period: PreferredPeriod): string => t(LABEL_KEYS[period]);

/**
 * A preferred day with its period, "Tue, Nov 4 · Morning": a line breaks after the dot, never
 * inside the period, nor inside the day unless `wrapDay` lets a long one ("Wednesday,
 * November 11", on a line of its own) wrap at its spaces at a large font size. The day stands
 * alone when the period is flexible, or unknown: requests made before #237 carry none.
 */
export function withPeriod(
  t: TFunction,
  day: string,
  period: PreferredPeriod | null,
  { wrapDay = false }: { wrapDay?: boolean } = {},
): string {
  const shown = wrapDay ? day : keepTogether(day);
  return period === null || period === FLEXIBLE_PERIOD
    ? shown
    : `${shown}${FACT_SEPARATOR}${keepTogether(periodLabel(t, period))}`;
}
