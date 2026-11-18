import { ApiError } from "@/lib/api";

import {
  type Decision,
  dollarsToCents,
  isDecision,
  NOTE_MAX_LENGTH,
  type ResolveError,
} from "./disputes";

/** What the API takes to resolve a dispute (DisputeResolveIn). */
export type ResolveBody = { decision: Decision; pro_release_cents?: number; note: string };

const CONFLICTS: ReadonlySet<string> = new Set<ResolveError>([
  "dispute_already_resolved",
  "resolution_in_progress",
  "refund_already_attempted",
  "refund_pending",
  "refund_failed",
  "dispute_needs_review",
]);

/**
 * A failed resolve as one of RESOLVE_ERRORS, from the API's status and code, never its text.
 * Anything that is not an answer from the API (a timeout, a dropped connection) is
 * `unconfirmed`: the decision may have gone through, so the page is read again before anyone
 * sends it once more.
 */
export function resolveErrorOf(failure: unknown): ResolveError {
  if (!(failure instanceof ApiError)) return "unconfirmed";
  const { status, code } = failure;
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409 && code && CONFLICTS.has(code)) return code as ResolveError;
  if (status === 422) return code === "invalid_split" ? "invalid_split" : "validation_error";
  if (status === 502) return "payments_error";
  if (status === 503) return code === "not_configured" ? "not_configured" : "payments_unavailable";
  return "unavailable";
}

/**
 * The body a resolve form carries, as the API takes it, or why it cannot be sent: a known
 * decision; for a partial only, the amount typed in dollars, sent in cents (more than 0: the
 * API checks it against the payout); a note, trimmed, one to NOTE_MAX_LENGTH characters.
 */
export function resolveBodyOf(form: FormData): ResolveBody | ResolveError {
  const decision = form.get("decision");
  if (!isDecision(decision)) return "validation_error";
  const typed = form.get("note");
  const note = typeof typed === "string" ? typed.trim() : "";
  if (note === "" || note.length > NOTE_MAX_LENGTH) return "validation_error";
  if (decision !== "partial") return { decision, note };
  const amount = form.get("amount");
  const cents = typeof amount === "string" ? dollarsToCents(amount) : null;
  if (cents === null || cents <= 0) return "invalid_split";
  return { decision, pro_release_cents: cents, note };
}
