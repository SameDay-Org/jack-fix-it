"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Reads the page's data again every `everyMs` while the tab is visible. `router.refresh()`
 * re-renders the server components and keeps the client state (the filters being typed, the
 * scroll position, the running timers), so the list updates without a flash.
 */
export function AutoRefresh({ everyMs }: { everyMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => clearInterval(timer);
  }, [router, everyMs]);
  return null;
}
