import { router } from "expo-router";
import { useCallback, useRef } from "react";

/**
 * Closes a sheet once, whoever asks first: its own answer, or the job moving on under it. A
 * second `router.back()` would pop the job screen too. `leaving` stays true from then on, so the
 * sheet keeps drawing what it showed while it slides away.
 */
export function useSheetExit() {
  const leaving = useRef(false);
  const leave = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    router.back();
  }, []);
  return { leave, leaving };
}
