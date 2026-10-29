import { useState } from "react";

import { parsePriceCents, priceText } from "./money";
import {
  defaultStartAt,
  draftProblems,
  emptyDraft,
  hasProblems,
  isDirty,
  type DraftProblems,
  type QuoteDraft,
} from "./quoteDraft";

/** The day and time steppers move the start by these; the duration steppers by an hour and 15 min. */
export const START_STEP_MINUTES = 30;
export const DURATION_MINUTES_STEP = 15;
const MINUTES_PER_HOUR = 60;

/** The same wall-clock time `days` days later (or earlier), across a daylight-saving change too. */
export function shiftDays(at: number, days: number): number {
  const date = new Date(at);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

export function shiftMinutes(at: number, minutes: number): number {
  const date = new Date(at);
  date.setMinutes(date.getMinutes() + minutes);
  return date.getTime();
}

/**
 * The server refused the amount or the duration as above a cap (422); the mark stays on a
 * field until that field changes, whatever else the pro edits.
 */
function keepCapMarks(
  previous: DraftProblems,
  next: DraftProblems,
  changed: Partial<QuoteDraft>,
): DraftProblems {
  const kept = { ...next };
  if (previous.price === "aboveCap" && !("price" in changed) && !kept.price) {
    kept.price = "aboveCap";
  }
  if (previous.duration === "aboveCap" && !("durationMinutes" in changed) && !kept.duration) {
    kept.duration = "aboveCap";
  }
  return kept;
}

/**
 * The quote the pro is writing, kept while the form, the review and a failed send come and go.
 * Problems show from the first "Review quote" on and then follow every change. `now` is the time
 * of the last change, for the steppers' lower bounds: the start can't be stepped into the past.
 */
export function useQuoteDraft(preferredDate: string | null) {
  const [initial] = useState(() => emptyDraft(defaultStartAt(preferredDate, Date.now())));
  const [draft, setDraft] = useState(initial);
  const [now, setNow] = useState(Date.now);
  const [checking, setChecking] = useState(false);
  const [problems, setProblems] = useState<DraftProblems>({});

  const change = (patch: Partial<QuoteDraft>) => {
    const next = { ...draft, ...patch };
    const at = Date.now();
    setDraft(next);
    setNow(at);
    if (checking) setProblems((previous) => keepCapMarks(previous, draftProblems(next, at), patch));
  };

  /** Checks everything the app can; true when the draft may go to the review. */
  const check = (): boolean => {
    const found = draftProblems(draft, Date.now());
    setChecking(true);
    setProblems(found);
    return !hasProblems(found);
  };

  /**
   * The server answered 422. A field that fails here now (a start that passed while the pro was
   * reviewing) is the cause; otherwise it is a platform cap the app does not know (#258), on the
   * amount or the duration.
   */
  const refused = () => {
    const found = draftProblems(draft, Date.now());
    setChecking(true);
    setProblems(hasProblems(found) ? found : { price: "aboveCap", duration: "aboveCap" });
  };

  /** The price field lost focus: a valid price is rewritten as "1000.00". */
  const tidyPrice = () => {
    const cents = parsePriceCents(draft.price);
    if (cents !== null && priceText(cents) !== draft.price) change({ price: priceText(cents) });
  };

  const hours = Math.floor(draft.durationMinutes / MINUTES_PER_HOUR);
  const minutes = draft.durationMinutes % MINUTES_PER_HOUR;

  return {
    draft,
    problems,
    now,
    dirty: isDirty(draft, initial),
    check,
    refused,
    tidyPrice,
    setPrice: (price: string) => change({ price }),
    setScope: (scope: string) => change({ scope }),
    setApproach: (approach: string) => change({ approach }),
    duration: { hours, minutes },
    /** Where the day and time steppers would move the start back to, for their lower bounds. */
    dayBefore: shiftDays(draft.startAt, -1),
    stepEarlier: shiftMinutes(draft.startAt, -START_STEP_MINUTES),
    stepHours: (by: number) =>
      change({ durationMinutes: draft.durationMinutes + by * MINUTES_PER_HOUR }),
    stepMinutes: (by: number) =>
      change({ durationMinutes: draft.durationMinutes + by * DURATION_MINUTES_STEP }),
    stepDay: (by: number) => change({ startAt: shiftDays(draft.startAt, by) }),
    stepTime: (by: number) =>
      change({ startAt: shiftMinutes(draft.startAt, by * START_STEP_MINUTES) }),
  };
}

export type QuoteDraftState = ReturnType<typeof useQuoteDraft>;
