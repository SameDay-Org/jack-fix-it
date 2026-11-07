import type { ApiSchema } from "@jack/shared";
import type { TFunction } from "i18next";
import { Platform } from "react-native";

import { formatInstantDay, formatTimeOfDay } from "@/features/opportunities/format";
import { formatLocale } from "@/features/quotes/format";

import type { ProJob } from "./phase";

export type JobAddress = ApiSchema<"JobAddress">;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight of the day `at` falls on. */
function startOfDay(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Where the day stands: alone or opening a sentence ("Today"), or inside one ("today"). */
export type DayPlacement = "start" | "inline";

/**
 * The day of an instant as the pro reads it: "Today", "Tomorrow", or "Thu, Nov 7", against the
 * time the job was answered (`now`), in the device's time zone; lowercase inside a sentence
 * ("Scheduled for today, 8:00 AM").
 */
export function dayLabel(
  t: TFunction,
  at: number,
  now: number,
  locale = formatLocale(),
  placement: DayPlacement = "start",
): string {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  const inline = placement === "inline";
  if (days === 0) return inline ? t("proJobs.day.todayInline") : t("proJobs.day.today");
  if (days === 1) return inline ? t("proJobs.day.tomorrowInline") : t("proJobs.day.tomorrow");
  return formatInstantDay(at, locale);
}

/** "Today, 2:00 PM": when a job starts, for the list and for screen readers. */
export const whenLabel = (
  t: TFunction,
  iso: string,
  now: number,
  locale = formatLocale(),
  placement: DayPlacement = "start",
) =>
  t("proJobs.when", {
    day: dayLabel(t, Date.parse(iso), now, locale, placement),
    time: formatTimeOfDay(Date.parse(iso), locale),
  });

/** The customer's first name, or null when the API has none to show. */
export const customerName = (job: Pick<ProJob, "customer_first_name">): string | null =>
  job.customer_first_name?.trim() || null;

/** The address in two lines: the street (and unit), then "City, ST 33301". */
export function addressLines(address: JobAddress): [string, string] {
  const street = address.line2?.trim()
    ? `${address.line1.trim()}, ${address.line2.trim()}`
    : address.line1.trim();
  return [street, `${address.city}, ${address.state} ${address.zip_code}`];
}

/** The whole address on one line, as a maps search reads it. */
export const addressText = (address: JobAddress): string => addressLines(address).join(", ");

/**
 * A link that opens the address in the phone's maps app: Apple Maps on iOS, the Android map
 * chooser (`geo:`) on Android. A search for the address, never coordinates the app does not have.
 */
export function mapsUrl(address: JobAddress): string {
  const query = encodeURIComponent(addressText(address));
  return Platform.OS === "ios" ? `https://maps.apple.com/?q=${query}` : `geo:0,0?q=${query}`;
}
