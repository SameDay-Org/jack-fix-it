import { useCallback, useEffect, useRef } from "react";

/**
 * The signal of this mount: it aborts when the component unmounts. A request started with it is
 * cancelled when the user leaves, and code after an `await` checks `signal.aborted` before it
 * navigates, toasts, announces or writes anything, so a late answer acts on nothing.
 */
export function useUnmountSignal(): () => AbortSignal {
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    // A remount (React's development double mount) gets a live controller again.
    if (!controller.current || controller.current.signal.aborted) {
      controller.current = new AbortController();
    }
    const current = controller.current;
    return () => current.abort();
  }, []);

  return useCallback(() => {
    controller.current ??= new AbortController();
    return controller.current.signal;
  }, []);
}
