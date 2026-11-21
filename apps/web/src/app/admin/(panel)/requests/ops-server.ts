import { ApiError } from "@/lib/api";

import type { OpsError } from "./ops";

/** The API's default OPS_FOLLOWUP_MAX_DAYS (apps/api/app/config.py, `ops_followup_max_days`). */
export const DEFAULT_FOLLOWUP_MAX_DAYS = 30;

/**
 * OPS_FOLLOWUP_MAX_DAYS when it is a positive whole number, else the API's default: optional,
 * mirrors the API's, so the form refuses what the API would (the API checks again).
 */
export function followupMaxDays(): number {
  const days = Number(process.env.OPS_FOLLOWUP_MAX_DAYS);
  return Number.isInteger(days) && days > 0 ? days : DEFAULT_FOLLOWUP_MAX_DAYS;
}

const CODES: ReadonlySet<string> = new Set<OpsError>([
  "request_held",
  "request_not_found",
  "request_not_classifiable",
  "category_inactive",
  "followup_due_out_of_range",
  "assignee_not_staff",
  "followup_not_found",
  "rate_limited",
]);

/**
 * A refused action as one of OPS_ERRORS, from the API's status and code, never its text.
 * Anything that is not an answer from the API (a timeout, a dropped connection) is
 * `unconfirmed`: the action may have gone through, so the card is read again before anyone
 * sends it once more.
 */
export function opsErrorOf(failure: unknown): OpsError {
  if (!(failure instanceof ApiError)) return "unconfirmed";
  if (failure.code && CODES.has(failure.code)) return failure.code as OpsError;
  if (failure.status === 403) return "forbidden";
  if (failure.status === 404) return "request_not_found";
  if (failure.status === 429) return "rate_limited";
  if (failure.status === 422) return "validation_error";
  return "unavailable";
}
