"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import { type AgeLimits, type AgeTone, ageUnit, disputeAge } from "./disputes";

export type AgeTimerText = {
  /** "Opened {{count}} min ago", and the same in hours and days. */
  minutes: string;
  hours: string;
  days: string;
  /** Said after the age once it turns amber, then red, so color is never the only signal. */
  warn: string;
  late: string;
};

// The ops queue's timer colors: quiet, amber (navy text on the warning fill), red.
const TONE: Record<AgeTone, string> = {
  calm: "bg-gray-50 text-navy-900",
  warn: "bg-warning text-navy-900",
  late: "bg-danger text-white",
};

/** One minute: the age is said in minutes at most. */
const TICK_MS = 60_000;

/**
 * How long ago a dispute was opened, turning amber after `limits.warnHours` and red after
 * `limits.lateHours`. The server renders it at its own clock (`serverNow`) and the browser
 * takes over with its own, so the two first renders match; it then moves on every minute.
 */
export function AgeTimer({
  openedAt,
  serverNow,
  limits,
  text,
}: {
  openedAt: string;
  serverNow: string;
  limits: AgeLimits;
  text: AgeTimerText;
}) {
  const [now, setNow] = useState(() => Date.parse(serverNow));
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const { minutes, tone } = disputeAge(now, openedAt, limits);
  const { unit, count } = ageUnit(minutes);
  const age = text[unit].replace("{{count}}", String(count));
  const label = tone === "calm" ? age : `${age} · ${tone === "late" ? text.late : text.warn}`;

  return (
    <span
      data-tone={tone}
      suppressHydrationWarning
      className={cn(
        "inline-flex items-center rounded-pill px-3 py-1 text-xs font-semibold whitespace-nowrap tabular-nums",
        TONE[tone],
      )}
    >
      {label}
    </span>
  );
}
