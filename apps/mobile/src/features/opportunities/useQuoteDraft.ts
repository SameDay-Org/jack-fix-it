import { useLayoutEffect, useRef, useState } from "react";

import { parsePriceCents, priceText } from "./money";
import {
  defaultStartAt,
  draftProblems,
  emptyDraft,
  firstProblem,
  isDirty,
  recheckCaps,
  sameCaps,
  type DraftProblems,
  type QuoteCaps,
  type QuoteDraft,
  type QuoteField,
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
 * The server refused the amount or the duration as above a cap the app could not name (422); the
 * mark stays on a field until that field changes, whatever else the pro edits.
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
 * Problems show from the first "Review quote" on and then follow every change, checked against
 * the opportunity's `caps`, and against new caps when its detail refreshes meanwhile. `now` is
 * the time of the last change, for the steppers' lower bounds: the start can't be stepped into
 * the past.
 */
export function useQuoteDraft(preferredDate: string | null, caps: QuoteCaps) {
  const [initial] = useState(() => emptyDraft(defaultStartAt(preferredDate, Date.now())));
  const [draft, setDraft] = useState(initial);
  const [now, setNow] = useState(Date.now);
  const [checking, setChecking] = useState(false);
  const [problems, setProblems] = useState<DraftProblems>({});
  // Adjusted while rendering, so no mark ever names a cap that no longer holds, not even once.
  const [checkedCaps, setCheckedCaps] = useState(caps);
  if (!sameCaps(caps, checkedCaps)) {
    setCheckedCaps(caps);
    if (checking) {
      setProblems((previous) => keepCapMarks(previous, recheckCaps(previous, draft, caps), {}));
    }
  }

  // A send's answer lands in a callback made when Send was pressed: it reads the caps of now.
  const capsNow = useRef(caps);
  useLayoutEffect(() => {
    capsNow.current = caps;
  }, [caps]);

  const change = (patch: Partial<QuoteDraft>) => {
    const next = { ...draft, ...patch };
    const at = Date.now();
    setDraft(next);
    setNow(at);
    if (checking) {
      setProblems((previous) => keepCapMarks(previous, draftProblems(next, at, caps), patch));
    }
  };

  /**
   * Checks everything the app can, under the caps the opportunity states now, and marks what it
   * finds: the first field down the form that cannot be sent, or none when the draft may go on
   * (to the review, and from the review out).
   */
  const check = (): QuoteField | undefined => {
    const found = draftProblems(draft, Date.now(), caps);
    setChecking(true);
    setProblems(found);
    return firstProblem(found);
  };

  /**
   * The server answered 422. A field that fails here now is the cause: the start went by, or the
   * detail lowered a cap, while the quote was out. Otherwise the caps changed without the app
   * learning it, and it cannot name them: the amount or the duration. Returns the first field it
   * marked.
   */
  const refused = (): QuoteField => {
    const found = draftProblems(draft, Date.now(), capsNow.current);
    const first = firstProblem(found);
    setChecking(true);
    setProblems(first ? found : { price: "aboveCap", duration: "aboveCap" });
    return first ?? "price";
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
    /** The caps the problems were found under, which a message names. */
    caps,
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
