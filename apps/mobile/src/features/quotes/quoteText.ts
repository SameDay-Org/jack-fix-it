import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { expiryAt } from "./expiry";
import { formatDateTime, formatLocale, formatMinutes, formatMoney, formatRating } from "./format";
import type { CustomerQuote } from "./useRequestQuotes";

/**
 * Where a quote stands for the customer: `accepted`; `expired` (by the server, or its
 * `expires_at` passed on screen); `open` to accept; `closed`, pending but not acceptable because
 * another quote of the request was accepted.
 */
export type QuoteState = "accepted" | "expired" | "open" | "closed";

export function quoteStateOf(quote: CustomerQuote, now: number, anyAccepted: boolean): QuoteState {
  if (quote.status === "accepted") return "accepted";
  if (quote.status !== "pending" || expiryAt(quote.expires_at, now).kind === "expired") {
    return "expired";
  }
  return anyAccepted ? "closed" : "open";
}

export type QuoteText = {
  price: string;
  pro: string;
  duration: string;
  start: string;
  /** "★ 4.8 · 12 jobs · 8 years of experience"; "New" before the first review. */
  stats: string;
  /** "Expires in 3 h 20 min", "Expires Fri, Oct 31, 5:00 PM" or "Expired". */
  expiry: string;
  /** The whole card in one sentence for screen readers: pro, verified, price, start, and the rest. */
  summary: string;
};

/** The pro's name, or the neutral label when the API withholds it; never an empty string. */
export const proName = (t: TFunction, quote: CustomerQuote): string =>
  quote.pro.name?.trim() || t("quotes.proFallback");

function expiryText(t: TFunction, quote: CustomerQuote, now: number, locale: string): string {
  const expiry = expiryAt(quote.expires_at, now);
  if (quote.status === "expired" || expiry.kind === "expired") return t("quotes.expired");
  if (expiry.kind === "date") {
    return t("quotes.expiresOn", { date: formatDateTime(quote.expires_at, locale) });
  }
  return t("quotes.expiresIn", { span: formatMinutes(t, expiry.minutes) });
}

export function quoteText(
  t: TFunction,
  quote: CustomerQuote,
  state: QuoteState,
  now: number,
  locale: string = formatLocale(),
): QuoteText {
  const { pro } = quote;
  const name = proName(t, quote);
  const price = formatMoney(quote.amount_cents, locale);
  const duration = t("quotes.duration", { span: formatMinutes(t, quote.duration_minutes) });
  const start = t("quotes.starts", { date: formatDateTime(quote.proposed_start_at, locale) });
  const rating = formatRating(pro.rating_avg, locale);
  const jobs = t("quotes.jobs", { count: pro.jobs_count });
  const years =
    pro.years_of_experience === null ? null : t("quotes.years", { count: pro.years_of_experience });
  const expiry = expiryText(t, quote, now, locale);

  const stats = [rating === null ? t("quotes.ratingNew") : `★ ${rating}`, jobs, years]
    .filter((part) => part !== null)
    .join(" · ");
  const summary = [
    name,
    pro.verified ? t("quotes.verified") : null,
    price,
    start,
    duration,
    rating === null ? t("quotes.notRated") : t("quotes.rated", { rating }),
    jobs,
    years,
    state === "accepted" ? t("quotes.acceptedNote") : expiry,
  ]
    .filter((part) => part !== null)
    .join(", ");

  return { price, pro: name, duration, start, stats, expiry, summary };
}

/** `quoteText` in the app's language, redrawn as `now` moves. */
export function useQuoteText(quote: CustomerQuote, state: QuoteState, now: number): QuoteText {
  const { t } = useTranslation();
  return quoteText(t, quote, state, now);
}
