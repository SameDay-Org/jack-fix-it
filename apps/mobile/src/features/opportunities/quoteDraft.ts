import type { ApiSchema } from "@jack/shared";

import { MAX_AMOUNT_CENTS, parsePriceCents } from "./money";

export type QuoteCreate = ApiSchema<"QuoteCreate">;

/** `QuoteCreate`'s bounds on the two notes (`SCOPE_MAX_LENGTH`, `APPROACH_MAX_LENGTH`). */
export const SCOPE_MAX_LENGTH = 2000;
export const APPROACH_MAX_LENGTH = 2000;

/** The proposed start defaults to this hour of the customer's preferred day (#249). */
const DEFAULT_START_HOUR = 9;

/** What the pro has typed and picked; kept as is while the form, the review and a retry come and go. */
export type QuoteDraft = {
  /** The price as typed, in dollars ("100.50"); parsed only to cents. */
  price: string;
  scope: string;
  approach: string;
  durationMinutes: number;
  /** The proposed start, epoch milliseconds in the device's time zone. */
  startAt: number;
};

export type QuoteField = "price" | "scope" | "duration" | "start";

/**
 * Why a field cannot be sent: `required` (empty or zero), `invalid` (not a price, or $0),
 * `past` (the start is no longer in the future), `aboveCap` (the server refused the amount or the
 * duration as above the platform's caps, which the app does not know: #258).
 */
export type FieldProblem = "required" | "invalid" | "past" | "aboveCap";

export type DraftProblems = Partial<Record<QuoteField, FieldProblem>>;

export const emptyDraft = (startAt: number): QuoteDraft => ({
  price: "",
  scope: "",
  approach: "",
  durationMinutes: 0,
  startAt,
});

/**
 * The start the form opens with: the customer's preferred day at 9:00 AM while that is still
 * ahead, otherwise the next whole hour.
 */
export function defaultStartAt(preferredDate: string | null, now: number): number {
  if (preferredDate !== null) {
    const [year, month, day] = preferredDate.split("-").map(Number);
    if (year !== undefined && month !== undefined && day !== undefined) {
      const preferred = new Date(year, month - 1, day, DEFAULT_START_HOUR).getTime();
      if (preferred > now) return preferred;
    }
  }
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return next.getTime();
}

function priceProblem(price: string): FieldProblem | undefined {
  if (price.trim() === "") return "required";
  const cents = parsePriceCents(price);
  if (cents === null || cents === 0) return "invalid";
  if (cents > MAX_AMOUNT_CENTS) return "aboveCap";
  return undefined;
}

/** Everything the app can check before sending; an empty result means the draft can be sent. */
export function draftProblems(draft: QuoteDraft, now: number): DraftProblems {
  const problems: DraftProblems = {};
  const price = priceProblem(draft.price);
  if (price) problems.price = price;
  if (draft.scope.trim() === "") problems.scope = "required";
  if (draft.durationMinutes <= 0) problems.duration = "required";
  if (draft.startAt <= now) problems.start = "past";
  return problems;
}

export const hasProblems = (problems: DraftProblems): boolean => Object.keys(problems).length > 0;

/** The pro has typed or changed something that a discard would lose. */
export const isDirty = (draft: QuoteDraft, initial: QuoteDraft): boolean =>
  draft.price.trim() !== "" ||
  draft.scope.trim() !== "" ||
  draft.approach.trim() !== "" ||
  draft.durationMinutes !== initial.durationMinutes ||
  draft.startAt !== initial.startAt;

/**
 * The request body for a draft that passed `draftProblems`. The notes go trimmed, as the server
 * stores them, and a blank "How I'll do the job" is left out.
 */
export function quoteBody(draft: QuoteDraft): QuoteCreate {
  const amountCents = parsePriceCents(draft.price);
  if (amountCents === null) throw new RangeError("the draft's price is not valid");
  const approach = draft.approach.trim();
  return {
    amount_cents: amountCents,
    scope: draft.scope.trim(),
    ...(approach === "" ? {} : { approach }),
    duration_minutes: draft.durationMinutes,
    proposed_start_at: new Date(draft.startAt).toISOString(),
  };
}
