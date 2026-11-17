import type { TFunction } from "i18next";

import type { StatusTone } from "@/components/ui";
import { formatLocale } from "@/features/quotes/format";

import type { DocumentRow, DocumentState } from "./documents";

export const STATE_TONE: Record<DocumentState, StatusTone> = {
  missing: "warning",
  pending: "info",
  approved: "success",
  rejected: "danger",
};

/** A day as the document carries it ("2027-03-12"), read in UTC so it never names the day before. */
export function formatDay(isoDate: string, locale: string = formatLocale()): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(isoDate));
}

/** The lines under a document's name: why it was rejected, and when it expires. */
export function documentFacts(t: TFunction, { state, document }: DocumentRow): string[] {
  const reason = state === "rejected" ? document?.rejection_reason?.trim() : undefined;
  return [
    ...(reason ? [t("proDocuments.reason", { reason })] : []),
    ...(document?.expires_on
      ? [t("proDocuments.expires", { date: formatDay(document.expires_on) })]
      : []),
  ];
}
