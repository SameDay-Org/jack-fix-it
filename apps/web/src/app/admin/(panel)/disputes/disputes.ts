import type { components } from "@jack/shared";

export type DisputeItem = components["schemas"]["StaffDisputeSummary"];
export type Dispute = components["schemas"]["StaffDisputeOut"];
export type DisputeStatus = components["schemas"]["DisputeStatus"];
export type Decision = components["schemas"]["ResolutionDecision"];
export type Refund = components["schemas"]["RefundOut"];

export const DISPUTES_PATH = "/admin/disputes";

/** The list's two views: open disputes first in line, then the resolved ones. */
export const DISPUTE_FILTERS = ["open", "resolved"] as const satisfies readonly DisputeStatus[];

/** What an admin may decide, in the order the control offers them. */
export const DECISIONS = ["release", "partial", "refund"] as const satisfies readonly Decision[];

/** The longest note the API takes (DisputeResolveIn.note, NOTE_MAX_LENGTH); it checks again. */
export const NOTE_MAX_LENGTH = 1000;

/** The view from `?status=`: open disputes unless the URL names the resolved ones. */
export function toFilter(value: string | string[] | undefined): DisputeStatus {
  return value === "resolved" ? "resolved" : "open";
}

export function listHref(filter: DisputeStatus): string {
  return filter === "open" ? DISPUTES_PATH : `${DISPUTES_PATH}?status=${filter}`;
}

export function disputeHref(disputeId: string): string {
  return `${DISPUTES_PATH}/${disputeId}`;
}

/** A photo of the dispute, through the panel's own route: never the storage's signed address. */
export function photoHref(disputeId: string, photoId: string): string {
  return `${disputeHref(disputeId)}/photos/${photoId}`;
}

export function isDecision(value: unknown): value is Decision {
  return DECISIONS.some((decision) => decision === value);
}

/** How long a dispute has waited: quiet, then amber, then red. */
export type AgeTone = "calm" | "warn" | "late";

/** The hours after which a dispute's age turns amber, then red. */
export type AgeLimits = { warnHours: number; lateHours: number };

/** A dispute's age in whole minutes (never below one), and its tone. */
export function disputeAge(
  nowMs: number,
  openedAt: string,
  limits: AgeLimits,
): { minutes: number; tone: AgeTone } {
  const minutes = Math.max(1, Math.floor((nowMs - Date.parse(openedAt)) / 60_000));
  const hours = minutes / 60;
  const tone = hours >= limits.lateHours ? "late" : hours >= limits.warnHours ? "warn" : "calm";
  return { minutes, tone };
}

/** An age as people say it: minutes under an hour, hours under two days, then days. */
export function ageUnit(minutes: number): { unit: "minutes" | "hours" | "days"; count: number } {
  if (minutes < 60) return { unit: "minutes", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return { unit: "hours", count: hours };
  return { unit: "days", count: Math.floor(hours / 24) };
}

/**
 * Cents in the reader's locale, in the currency the API names (Stripe's lower-case code), or
 * in US dollars when the API has none (a dispute whose payment is missing). Display only:
 * every amount is the API's.
 */
export function formatMoney(cents: number, currency: string | null, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: (currency ?? "usd").toUpperCase(),
  }).format(cents / 100);
}

/** Dollars as typed: whole dollars, then at most a dot and cents. An optional `$` in front. */
const DOLLARS = /^\$?\s*([0-9]{1,9})(?:\.([0-9]+))?$/;

/**
 * The cents an amount typed in dollars stands for, rounded half up to the cent ("12.345" is
 * 1235), or null when it is not an amount (a sign, a comma, letters, nothing). Done on the
 * digits, never in floating point.
 */
export function dollarsToCents(typed: string): number | null {
  const match = DOLLARS.exec(typed.trim());
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  const digits = (fraction + "000").slice(0, 3);
  const rounded = Math.floor(Number(digits) / 10) + (Number(digits[2]) >= 5 ? 1 : 0);
  return Number(whole) * 100 + rounded;
}

/** Why a partial amount cannot be sent, as the API would refuse it. */
export type AmountError = "format" | "zero" | "not_less";

/**
 * A partial release must be more than 0 and less than the pro's payout: all of it is a
 * release, none of it a refund. The API checks the same (`invalid_split`).
 */
export function amountError(cents: number | null, payoutCents: number): AmountError | null {
  if (cents === null) return "format";
  if (cents <= 0) return "zero";
  if (cents >= payoutCents) return "not_less";
  return null;
}

/**
 * What the page says about the decision's refund:
 * - `failed`: Stripe failed or canceled it, the money did not go back (staff repair it);
 * - `pending`: Stripe has not finished it, or an attempt is under way (the dispute stays open);
 * - `attempt_failed`: the last attempt's call failed (Stripe refused it, or did not answer);
 * - null: no refund, or the money is back.
 * Stripe's own status (`stripe_status`) comes first: it is the only one that says where the
 * money is.
 */
export type RefundState = "pending" | "failed" | "attempt_failed" | null;

/** Stripe's refund statuses the panel names; any other is shown by the row's own status. */
export const STRIPE_REFUND_STATUSES = [
  "succeeded",
  "pending",
  "requires_action",
  "failed",
  "canceled",
] as const;
export type StripeRefundStatus = (typeof STRIPE_REFUND_STATUSES)[number];

export function stripeRefundStatus(refund: Refund): StripeRefundStatus | null {
  return STRIPE_REFUND_STATUSES.find((status) => status === refund.stripe_status) ?? null;
}

export function refundState(refund: Refund | null): RefundState {
  if (!refund) return null;
  const stripe = stripeRefundStatus(refund);
  if (stripe === "failed" || stripe === "canceled") return "failed";
  if (stripe === "pending" || stripe === "requires_action") return "pending";
  if (stripe === "succeeded") return null;
  if (refund.status === "failed") return "attempt_failed";
  if (refund.status === "pending") return "pending";
  return null;
}

/** The outcomes a resolve can end with, each with its own calm message. */
export const RESOLVE_ERRORS = [
  "forbidden",
  "not_found",
  "dispute_already_resolved",
  "resolution_in_progress",
  "refund_already_attempted",
  "refund_pending",
  "refund_failed",
  "dispute_needs_review",
  "invalid_split",
  "validation_error",
  "payments_error",
  "payments_unavailable",
  "not_configured",
  "offline",
  "unconfirmed",
  "unavailable",
] as const;
export type ResolveError = (typeof RESOLVE_ERRORS)[number];
