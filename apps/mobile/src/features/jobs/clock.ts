import { useEffect, useState } from "react";

const MINUTE_MS = 60_000;

/**
 * The time a job's words are drawn at ("in 12 min"): moves on at each minute boundary, and never
 * reads earlier than `atLeast` (the last answer's time), so a fresh answer is never worded against
 * a clock a minute old.
 */
export function useMinuteClock(atLeast = 0): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), MINUTE_MS - (now % MINUTE_MS));
    return () => clearTimeout(timer);
  }, [now]);

  return Math.max(now, atLeast);
}
