import { useCallback, useEffect, useState } from "react";

const MS_PER_SECOND = 1000;

/**
 * Whole seconds left until a deadline `seconds` from the last `restart` (from mount at first). Each
 * tick re-reads the clock, so a late tick never stretches the wait.
 */
export function useCountdown(seconds: number): { remaining: number; restart: () => void } {
  const [deadline, setDeadline] = useState(() => Date.now() + seconds * MS_PER_SECOND);
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / MS_PER_SECOND));
      setRemaining(left);
      if (left === 0) clearInterval(timer);
    }, MS_PER_SECOND);
    return () => clearInterval(timer);
  }, [deadline]);

  const restart = useCallback(() => {
    setRemaining(seconds);
    setDeadline(Date.now() + seconds * MS_PER_SECOND);
  }, [seconds]);

  return { remaining, restart };
}
