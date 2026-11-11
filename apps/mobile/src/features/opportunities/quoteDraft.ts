import type { ApiSchema } from "@jack/shared";

import { MAX_AMOUNT_CENTS, parsePriceCents } from "./money";

export type QuoteCreate = ApiSchema<"QuoteCreate">;

/**
 * The platform's caps on one quote as the opportunity states them (#258): the highest price in
 * cents and the longest duration in minutes, each `null` when there is no cap.
 */
export type QuoteCaps = Pick<
  ApiSchema<"OpportunityDetail">,
  "quote_max_amount_cents" | "quote_max_duration_minutes"
>;

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
 * `past` (the start is no longer in the future), `aboveMax` (above the cap the opportunity
 * states, which its message names), `aboveCap` (above a limit the app cannot name: the server
 * refused the amount or the duration under caps changed since the opportunity opened, or the
 * price is past the largest amount the API takes).
 */
export type FieldProblem = "required" | "invalid" | "past" | "aboveMax" | "aboveCap";

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

/** A cap holds a value up to it, the cap itself included; `null` is no cap. */
const aboveMax = (value: number, max: number | null): boolean => max !== null && value > max;

function priceProblem(price: string, maxCents: number | null): FieldProblem | undefined {
  if (price.trim() === "") return "required";
  const cents = parsePriceCents(price);
  if (cents === null || cents === 0) return "invalid";
  // A cap is never past the API's largest amount, so it is the limit worth naming.
  if (aboveMax(cents, maxCents)) return "aboveMax";
  if (cents > MAX_AMOUNT_CENTS) return "aboveCap";
  return undefined;
}

function durationProblem(minutes: number, maxMinutes: number | null): FieldProblem | undefined {
  if (minutes <= 0) return "required";
  if (aboveMax(minutes, maxMinutes)) return "aboveMax";
  return undefined;
}

/**
 * Everything the app can check before sending, the opportunity's caps included; an empty result
 * means the draft can be sent. The server checks the caps again: they can change meanwhile.
 */
export function draftProblems(draft: QuoteDraft, now: number, caps: QuoteCaps): DraftProblems {
  const problems: DraftProblems = {};
  const price = priceProblem(draft.price, caps.quote_max_amount_cents);
  if (price) problems.price = price;
  if (draft.scope.trim() === "") problems.scope = "required";
  const duration = durationProblem(draft.durationMinutes, caps.quote_max_duration_minutes);
  if (duration) problems.duration = duration;
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
