import { router } from "expo-router";
import { useCallback, useRef, useState } from "react";

/**
 * Closes a sheet once, whoever asks first: its own answer, or the job moving on under it. A
 * second `router.back()` would pop the job screen too. `leaving` stays true from then on, so the
 * sheet keeps drawing what it showed while it slides away. `sameSession` is false once the
 * session the sheet opened in is over: the cache it read is gone with it, which is not the job
 * moving on, and the signed-out shell takes the screens away without a back.
 */
export function useSheetExit(generation: number) {
  const [openedIn] = useState(generation);
  const leaving = useRef(false);
  const leave = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    router.back();
  }, []);
  return { leave, leaving, sameSession: generation === openedIn };
}
