import type { TFunction } from "i18next";

import { formatLocale, formatMinutes } from "@/features/quotes/format";

import type { JobRoute } from "./api";

const METERS_PER_MILE = 1609.344;
const SECONDS_PER_MINUTE = 60;
// Under ten miles one decimal reads well ("1.2 mi"); past that, whole miles.
const WHOLE_MILES_FROM = 10;

/** What the cards over the map say, and the one sentence a screen reader hears for the map. */
export type TrackingText = {
  eta: string | null;
  distance: string | null;
  street: string | null;
  /** The position is old or the pro stopped sharing it: "Waiting for location". */
  waiting: boolean;
  summary: string;
};

/** Meters as miles for the US launch: "0.4 mi", "1.2 mi", "12 mi". */
export function formatMiles(t: TFunction, meters: number, locale: string = formatLocale()): string {
  const miles = meters / METERS_PER_MILE;
  const digits = miles < WHOLE_MILES_FROM ? 1 : 0;
  const shown = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(miles);
  return t("jobs.liveMap.miles", { miles: shown });
}

/**
 * The cards' words: the route's time left (whole minutes, at least one) and distance, and the
 * street the pro is on now. Without a route (none yet, or the provider is down) the time falls
 * back to the minutes left of the arrival time the pro gave, if close, and nothing else is said.
 */
export function trackingText(
  t: TFunction,
  {
    name,
    route,
    etaMinutes,
    waiting,
  }: { name: string; route: JobRoute | null; etaMinutes: number | null; waiting: boolean },
): TrackingText {
  const minutes = route
    ? Math.max(1, Math.round(route.duration_s / SECONDS_PER_MINUTE))
    : etaMinutes;
  const eta = minutes === null ? null : formatMinutes(t, minutes);
  const street = route?.steps[0]?.street_name ?? null;
  const distance = route ? formatMiles(t, route.distance_m) : null;
  let summary: string;
  if (waiting) summary = t("jobs.liveMap.summary.waiting", { name });
  else if (eta && street)
    summary = t("jobs.liveMap.summary.etaStreet", { name, span: eta, street });
  else if (eta) summary = t("jobs.liveMap.summary.eta", { name, span: eta });
  else if (street) summary = t("jobs.liveMap.summary.street", { name, street });
  else summary = t("jobs.liveMap.summary.moving", { name });
  return { eta, distance, street, waiting, summary };
}
