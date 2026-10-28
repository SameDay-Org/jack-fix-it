import { useEffect, useState } from "react";

const MINUTE_MS = 60_000;
/** Up to a day left, a quote counts down ("Expires in 3 h 20 min"); further out it shows the date. */
const COUNTDOWN_MINUTES = 24 * 60;
/** setTimeout's ceiling (about 24.8 days); a longer wait just re-arms. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export type Expiry =
  | { kind: "expired" }
  /** Whole minutes left, rounded up: the label never says 0 while the quote can still be accepted. */
  | { kind: "countdown"; minutes: number }
  | { kind: "date" };

/** Where a quote's `expires_at` stands at `now` (epoch ms). */
export function expiryAt(expiresAt: string, now: number): Expiry {
  const left = Date.parse(expiresAt) - now;
  if (left <= 0) return { kind: "expired" };
  const minutes = Math.ceil(left / MINUTE_MS);
  return minutes > COUNTDOWN_MINUTES ? { kind: "date" } : { kind: "countdown", minutes };
}

/** Milliseconds until `expiryAt` answers differently for this quote; `null` once it has expired. */
export function msUntilExpiryChanges(expiresAt: string, now: number): number | null {
  const left = Date.parse(expiresAt) - now;
  if (left <= 0) return null;
  const minutes = Math.ceil(left / MINUTE_MS);
  return minutes > COUNTDOWN_MINUTES
    ? left - COUNTDOWN_MINUTES * MINUTE_MS
    : left - (minutes - 1) * MINUTE_MS;
}

/**
 * The time the quote labels are drawn at. It moves on exactly when one of `expiresAts` changes
 * label (a minute of the countdown passes, or a quote expires), so an Accept button goes away the
 * moment its quote expires, with no polling and no reload. Pass a stable array (memoized from the
 * query data): a new one re-arms the timer.
 */
export function useExpiryClock(expiresAts: readonly string[]): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    // Measured from the time on screen, not from this effect's run: a label that went out of date
    // in between (data that arrived late, a timer the OS held back) is redrawn at once.
    const waits = expiresAts
      .map((expiresAt) => msUntilExpiryChanges(expiresAt, now))
      .filter((wait): wait is number => wait !== null);
    if (waits.length === 0) return;
    const due = now + Math.min(...waits);
    const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, due - Date.now()));
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [expiresAts, now]);

  return now;
}
