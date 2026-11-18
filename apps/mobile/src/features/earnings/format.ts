import type { TFunction } from "i18next";

import type { StatusTone } from "@/components/ui";
import { categoryName } from "@/features/home/useCategories";
import { formatLocale, formatMoneyExact } from "@/features/quotes/format";

import type { Earning, EarningStatus, EarningsSummary } from "./api";

/** Each status's chip: its words carry the status, the tone only repeats it. */
export const STATUS_TONE: Record<EarningStatus, StatusTone> = {
  paid: "success",
  on_the_way: "info",
  awaiting_confirmation: "neutral",
  on_hold: "warning",
};

/** The four totals, in the order the screen lists them, each with the summary field it reads. */
export const FIGURES = [
  { key: "paid", field: "paid_cents" },
  { key: "on_the_way", field: "pending_cents" },
  { key: "awaiting_confirmation", field: "awaiting_confirmation_cents" },
  { key: "on_hold", field: "on_hold_cents" },
] as const satisfies readonly { key: EarningStatus; field: keyof EarningsSummary }[];

export const money = (cents: number, currency: string, locale: string = formatLocale()) =>
  formatMoneyExact(cents, locale, currency);

/** "Nov 12", with the year when it is not the year of `now` ("Dec 30, 2025"). */
export function formatEarningDay(iso: string, now: number, locale: string = formatLocale()) {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date);
}

/** What the job was, in the app's language; a job with no category is just "Job". */
export const earningTitle = (t: TFunction, item: Earning): string =>
  item.category ? categoryName(item.category) : t("earnings.row.noCategory");

/**
 * The dates a row shows for its status: when it was paid, or when it was completed; a job the
 * customer has not confirmed yet adds the day it usually confirms by, only when the API gives one.
 */
export function earningDates(t: TFunction, item: Earning, now: number): string[] {
  const day = (iso: string) => formatEarningDay(iso, now);
  if (item.status === "paid" && item.paid_at) {
    return [t("earnings.row.paidOn", { date: day(item.paid_at) })];
  }
  const completed = t("earnings.row.completed", { date: day(item.completed_at) });
  if (item.status === "awaiting_confirmation" && item.expected_by) {
    return [completed, t("earnings.row.confirmedBy", { date: day(item.expected_by) })];
  }
  return [completed];
}

/** The row read as one: "House cleaning, $120.00, Paid, Paid on Nov 12". */
export function earningLabel(t: TFunction, item: Earning, currency: string, now: number): string {
  return [
    earningTitle(t, item),
    money(item.amount_cents, currency),
    t(`earnings.status.${item.status}`),
    ...earningDates(t, item, now),
  ].join(", ");
}
