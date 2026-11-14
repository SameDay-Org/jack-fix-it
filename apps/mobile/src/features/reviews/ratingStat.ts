import { useTranslation } from "react-i18next";

import { formatLocale, formatRating, joinFacts } from "@/features/quotes/format";

import { useMyRating } from "./api";

/**
 * The person's rating as the Account screen's stat shows it. `value` null: still loading (a
 * skeleton). A failed read with nothing to show is a muted "Unavailable": no alarm, no invented
 * number, and the row keeps its place for when it loads.
 */
export type RatingStat = {
  value: string | null;
  /** What a screen reader says after "Rating". */
  spoken: string;
  /** A star before the value: there is an average to show. */
  star: boolean;
  muted: boolean;
};

export function useRatingStat(): RatingStat {
  const { t } = useTranslation();
  const { data, isError } = useMyRating();

  if (data === undefined) {
    if (!isError) return { value: null, spoken: t("common.loading"), star: false, muted: false };
    const unavailable = t("reviews.rating.unavailable");
    return { value: unavailable, spoken: unavailable, star: false, muted: true };
  }
  const average = data.average === null ? null : formatRating(String(data.average));
  if (data.count === 0 || average === null) {
    const none = t("account.noRatings");
    return { value: none, spoken: none, star: false, muted: false };
  }
  const ratings = t("reviews.rating.count", {
    count: data.count,
    total: new Intl.NumberFormat(formatLocale()).format(data.count),
  });
  return {
    value: joinFacts([average, ratings]),
    spoken: t("reviews.rating.spoken", { average, ratings }),
    star: true,
    muted: false,
  };
}
