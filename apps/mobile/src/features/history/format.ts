import type { TFunction } from "i18next";

import type { IconTileProps, StatusTone } from "@/components/ui";
import { categoryName, type Category } from "@/features/home/useCategories";
import { OTHER_REQUEST_GLYPH } from "@/features/opportunities/format";
import { formatLocale } from "@/features/quotes/format";

/** Not a seeded category, so not in the catalog's glyph map: the other-request glyph instead. */
const OTHER_CATEGORY_SLUG = "other";

/**
 * Every `customer_status` the API sends (docs/glossary.md "Customer-visible statuses") and its
 * chip's tone: green where the customer has something to do (a quote to pick, a job to confirm),
 * navy while Jack or the pro has it, the solid success green once it is done, the warning pill
 * for a problem, and gray for what is just received or over.
 */
const STATUS_TONES = {
  "customerStatus.requestReceived": "neutral",
  "customerStatus.reviewing": "neutral",
  "customerStatus.findingAPro": "info",
  "customerStatus.quoteReady": "brand",
  "customerStatus.scheduled": "info",
  "customerStatus.professionalOnTheWay": "info",
  "customerStatus.inProgress": "info",
  "customerStatus.waitingForConfirmation": "brand",
  "customerStatus.completed": "success",
  "customerStatus.needsAttention": "warning",
  "customerStatus.cancelled": "neutral",
} as const satisfies Record<string, StatusTone>;

type CustomerStatusKey = keyof typeof STATUS_TONES;

const isCustomerStatus = (key: string): key is CustomerStatusKey =>
  Object.prototype.hasOwnProperty.call(STATUS_TONES, key);

export type StatusChip = { label: string; tone: StatusTone };

/**
 * The status in the customer's words, as a chip. A key this build does not know (a status the API
 * added later) shows no chip rather than the raw key.
 */
export function statusChip(t: TFunction, customerStatus: string): StatusChip | null {
  if (!isCustomerStatus(customerStatus)) return null;
  return { label: t(customerStatus), tone: STATUS_TONES[customerStatus] };
}

/**
 * The request's category from the catalog by id. None when it was filed without one, or its
 * category is no longer offered (the catalog lists active categories only).
 */
export const findCategory = (
  categories: readonly Category[],
  categoryId: string | null,
): Category | undefined =>
  categoryId === null ? undefined : categories.find((category) => category.id === categoryId);

/** The category's name in the app's language, or "Request" when there is no category to name. */
export const requestCategoryLabel = (t: TFunction, category: Category | undefined): string =>
  category ? categoryName(category) : t("history.customer.otherCategory");

/** What the row's tile draws: the category's glyph by slug, or the other-request glyph. */
export const requestTileProps = (
  category: Category | undefined,
): Pick<IconTileProps, "slug" | "glyph"> =>
  category ? { slug: category.slug } : { slug: OTHER_CATEGORY_SLUG, glyph: OTHER_REQUEST_GLYPH };

const DAY_MS = 86_400_000;
const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * When the request was sent, by the device's calendar: "Today", "Yesterday", then the date
 * ("Oct 28"), with the year once it is not this one. A time a little ahead of the device's clock
 * still reads "Today".
 */
export function sentDay(
  t: TFunction,
  createdAt: string,
  now: number,
  locale: string = formatLocale(),
): string {
  const sent = new Date(createdAt);
  const today = new Date(now);
  // Rounded: a day across a daylight-saving change is 23 or 25 hours long.
  const daysAgo = Math.round((startOfDay(today) - startOfDay(sent)) / DAY_MS);
  if (daysAgo <= 0) return t("history.customer.today");
  if (daysAgo === 1) return t("history.customer.yesterday");
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sent.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  }).format(sent);
}
