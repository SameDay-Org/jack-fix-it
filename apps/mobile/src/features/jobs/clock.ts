import { useEffect, useState } from "react";

const MINUTE_MS = 60_000;

/**
 * The time a job's words are drawn at ("in 12 min"). It moves on each time the minutes left to
 * `anchor` (the ETA) change, or at each wall-clock minute without one, so a countdown and its
 * "any minute now" turn on time; and it never reads earlier than `atLeast` (the last answer's
 * time), so a fresh answer is never worded against an older clock.
 */
export function useMinuteClock(atLeast = 0, anchor: number | null = null): number {
  const [now, setNow] = useState(() => Date.now());
  const shown = Math.max(now, atLeast);

  useEffect(() => {
    const base = anchor !== null && Number.isFinite(anchor) ? anchor : 0;
    const delay = (((base - shown) % MINUTE_MS) + MINUTE_MS) % MINUTE_MS || MINUTE_MS;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [anchor, shown]);

  return shown;
}
