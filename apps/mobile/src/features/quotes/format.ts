import { getLocales } from "expo-localization";
import type { TFunction } from "i18next";

import i18n from "@/i18n";

const CENTS_PER_DOLLAR = 100;
const MINUTES_PER_HOUR = 60;
const RATING_DIGITS = 1;

/**
 * The locale numbers and dates are written in: the device's own tag (its region, e.g. "es-MX")
 * when it speaks the app's language, otherwise the app's language alone, so an unsupported device
 * language never mixes its dates into English text.
 */
export function formatLocale(): string {
  const language = i18n.resolvedLanguage ?? "en";
  const device = getLocales()[0];
  return device?.languageCode === language && device.languageTag ? device.languageTag : language;
}

/**
 * Cents as US dollars: "$180" for whole dollars, "$180.50" otherwise. The amount stays integer
 * cents everywhere; the one division here only hands Intl a value to print, and two fraction
 * digits print any whole number of cents exactly.
 */
export function formatMoney(cents: number, locale: string = formatLocale()): string {
  const whole = cents % CENTS_PER_DOLLAR === 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / CENTS_PER_DOLLAR);
}

/** A span of minutes as "45 min", "2 h" or "1 h 30 min" (the units read the same in ES). */
export function formatMinutes(t: TFunction, minutes: number): string {
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const rest = minutes % MINUTES_PER_HOUR;
  if (hours === 0) return t("quotes.span.minutes", { minutes: rest });
  if (rest === 0) return t("quotes.span.hours", { hours });
  return t("quotes.span.hoursMinutes", { hours, minutes: rest });
}

/** The average rating with one decimal in the app's locale ("4.8", "4,8"); `null` before any review. */
export function formatRating(
  ratingAvg: string | null,
  locale: string = formatLocale(),
): string | null {
  if (ratingAvg === null) return null;
  const rating = Number(ratingAvg);
  if (!Number.isFinite(rating)) return null;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: RATING_DIGITS,
    maximumFractionDigits: RATING_DIGITS,
  }).format(rating);
}

/** A date and time in the device's time zone: "Thu, Oct 30, 9:00 AM". */
export function formatDateTime(iso: string, locale: string = formatLocale()): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}
