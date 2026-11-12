import type { TFunction } from "i18next";

import { formatLocale } from "@/features/quotes/format";

const DAY_MS = 86_400_000;

/** The calendar day of an instant in `timeZone` (the device's when undefined), as a UTC midnight. */
function calendarDay(at: number, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"));
}

/**
 * When a finished job confirms itself if the customer does not answer (`confirm_by`), in plain
 * words at `now`: "Confirms automatically today at 3:40 PM if you don't answer", "tomorrow at…",
 * "on Tuesday at…", or "any moment now" once the time has passed (the worker has not run yet).
 * Null without a usable time. The day and the time are the device's (or `timeZone`'s); the
 * spoken hour picks the article where a language needs it ("a la 1:40", "a las 3:40").
 */
export function deadlineText(
  t: TFunction,
  confirmBy: string | null,
  now: number,
  locale: string = formatLocale(),
  timeZone?: string,
): string | null {
  if (confirmBy === null) return null;
  const at = Date.parse(confirmBy);
  if (!Number.isFinite(at)) return null;
  if (at <= now) return t("jobs.finished.deadline.due");

  const days = Math.round((calendarDay(at, timeZone) - calendarDay(now, timeZone)) / DAY_MS);
  const clock = new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" });
  const hour = Number(clock.formatToParts(at).find((part) => part.type === "hour")?.value);
  const values = {
    time: clock.format(at),
    day: new Intl.DateTimeFormat(locale, { timeZone, weekday: "long" }).format(at),
    count: Number.isFinite(hour) ? hour : 0,
  };
  if (days <= 0) return t("jobs.finished.deadline.today", values);
  if (days === 1) return t("jobs.finished.deadline.tomorrow", values);
  return t("jobs.finished.deadline.day", values);
}
