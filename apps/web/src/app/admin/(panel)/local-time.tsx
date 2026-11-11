"use client";

import { useSyncExternalStore } from "react";

/** Date, time and the zone's short name: a time without its zone reads differently on each desk. */
function format(iso: string, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  }).format(new Date(iso));
}

const subscribe = () => () => {};

/**
 * A moment in the reader's own time zone. The server does not know that zone, so it renders
 * UTC; the browser swaps in the local time once it takes over. Browsers do not all format a
 * date exactly as Node does (the space before AM/PM, for one), so a difference in this text
 * while the browser takes over is expected, not a hydration error.
 */
export function LocalTime({ iso, locale }: { iso: string; locale: string }) {
  const text = useSyncExternalStore(
    subscribe,
    () => format(iso, locale),
    () => format(iso, locale, "UTC"),
  );
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {text}
    </time>
  );
}
