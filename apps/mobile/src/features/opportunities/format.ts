import type { ApiSchema } from "@jack/shared";
import type { TFunction } from "i18next";

import type { Glyph } from "@/components/icons";
import type { IconTileProps } from "@/components/ui";
import { deviceLocale } from "@/features/auth/locale";
import { formatLocale } from "@/features/quotes/format";

export type OpportunityCategory = ApiSchema<"OpportunityCategory">;
export type OpportunityLocation = ApiSchema<"OpportunityLocation">;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Past this many days the "sent" line shows the date rather than a count. */
const SENT_AGO_MAX_DAYS = 7;
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Not a seeded category, so not in the catalog's glyph map: its own glyph below. */
const OTHER_CATEGORY_SLUG = "other";

/**
 * A request filed without a category, in the category glyphs' drawing system (a 24-unit box,
 * one stroke, one flat accent under it): a written request on a clipboard, the clip in green.
 */
export const OTHER_REQUEST_GLYPH: Glyph = {
  accent: "M9 5.5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.5a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1Z",
  strokes: [
    "M9 4.5H7a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6.5a2 2 0 0 0-2-2h-2",
    "M9 5.5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.5a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1Z",
    "M8.5 11.5h7",
    "M8.5 15.5h4.5",
  ],
};

/**
 * The category's name in the app's language (English, then the slug, as fallbacks), or the label
 * for a request the customer filed without one.
 */
export function categoryLabel(t: TFunction, category: OpportunityCategory | null): string {
  if (!category) return t("opportunities.otherCategory");
  return category.names[deviceLocale()] ?? category.names.en ?? category.slug;
}

/** What the icon tile draws: the category's glyph by slug, or the other-request glyph. */
export const categoryTileProps = (
  category: OpportunityCategory | null,
): Pick<IconTileProps, "slug" | "glyph"> =>
  category ? { slug: category.slug } : { slug: OTHER_CATEGORY_SLUG, glyph: OTHER_REQUEST_GLYPH };

/**
 * The city and the ZIP, all the location a pro sees before payment (#49): "Fort Lauderdale
 * 33301", or the ZIP alone when its area is no longer served.
 */
export function locationLabel(location: OpportunityLocation): string {
  return location.city ? `${location.city} ${location.zip_code}` : location.zip_code;
}

/**
 * A calendar day from the API ("2026-10-30", no time zone) as "Thu, Oct 30". It is read as a
 * local date: parsed as an instant it would be UTC midnight, the evening before in the Americas.
 */
export function formatDay(day: string, locale: string = formatLocale()): string {
  const match = CALENDAR_DAY.exec(day);
  if (!match) return day;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

/** How long ago the request was sent to the pro ("2 h ago", "just now"); past a week, the date. */
export function sentAgo(
  t: TFunction,
  sentAt: string,
  now: number,
  locale: string = formatLocale(),
): string {
  const elapsed = Math.max(0, now - Date.parse(sentAt));
  if (elapsed < MINUTE_MS) return t("opportunities.ago.justNow");
  if (elapsed < HOUR_MS) {
    return t("opportunities.ago.minutes", { count: Math.floor(elapsed / MINUTE_MS) });
  }
  if (elapsed < DAY_MS)
    return t("opportunities.ago.hours", { count: Math.floor(elapsed / HOUR_MS) });
  if (elapsed < SENT_AGO_MAX_DAYS * DAY_MS) {
    return t("opportunities.ago.days", { count: Math.floor(elapsed / DAY_MS) });
  }
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(
    new Date(sentAt),
  );
  return t("opportunities.ago.on", { date });
}
