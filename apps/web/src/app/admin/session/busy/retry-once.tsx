"use client";

import { useEffect } from "react";

function assign(href: string): void {
  window.location.assign(href);
}

/**
 * The busy page's one retry (#530): it opens `href` once, `seconds` after the page shows, as a
 * full page load (the refresh route writes cookies). The refresh route marks that visit, so a
 * page it leads back to never schedules another. `go` is the navigation (tests replace it).
 */
export function RetryOnce({
  href,
  seconds,
  go = assign,
}: {
  href: string;
  seconds: number;
  go?: (href: string) => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(() => go(href), seconds * 1000);
    return () => window.clearTimeout(timer);
  }, [href, seconds, go]);
  return null;
}
