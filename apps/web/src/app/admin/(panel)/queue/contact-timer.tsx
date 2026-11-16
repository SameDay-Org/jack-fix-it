"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import { contactTimer, formatClock, type TimerTone } from "./queue";

export type ContactTimerText = {
  /** "{{time}} left" and "{{time}} late": `{{time}}` is replaced by the clock. */
  left: string;
  late: string;
};

// Calm is quiet, the second half of the time is amber (navy text on the warning fill), late
// is red: the same three states as words, so color is never the only signal.
const TONE: Record<TimerTone, string> = {
  calm: "bg-gray-50 text-navy-900",
  soon: "bg-warning text-navy-900",
  late: "bg-danger text-white",
};

/**
 * The time left for the first contact with a request, counting down every second; once the
 * time is up it counts how late the contact is. The server renders it at its own clock
 * (`serverNow`) and the browser takes over with its own, so the two first renders match.
 * A screen reader is told the state on each page load and refresh, not every second.
 */
export function ContactTimer({
  createdAt,
  dueAt,
  serverNow,
  text,
}: {
  createdAt: string;
  dueAt: string;
  serverNow: string;
  text: ContactTimerText;
}) {
  const [now, setNow] = useState(() => Date.parse(serverNow));
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const { seconds, tone } = contactTimer(now, createdAt, dueAt);
  const label = (tone === "late" ? text.late : text.left).replace("{{time}}", formatClock(seconds));

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
