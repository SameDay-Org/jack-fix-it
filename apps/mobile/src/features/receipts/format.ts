import type { TFunction } from "i18next";

import type { StatusTone } from "@/components/ui";
import { categoryName } from "@/features/home/useCategories";
import { formatLocale, formatMoneyExact } from "@/features/quotes/format";

import type { ReceiptLine, ReceiptOut, ReceiptStatus } from "./api";

/** The receipt's money in its own currency, cents shown (a receipt states every cent). */
export const receiptMoney = (cents: number, currency: string): string =>
  formatMoneyExact(cents, formatLocale(), currency);

/** A day on the receipt: "Nov 19, 2026" (the year always: a receipt is kept). */
export function receiptDay(iso: string): string {
  return new Intl.DateTimeFormat(formatLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

// Card brands as Stripe names them, as people write them (the same in every language).
const BRANDS: Record<string, string> = {
  amex: "American Express",
  diners: "Diners Club",
  discover: "Discover",
  jcb: "JCB",
  mastercard: "Mastercard",
  unionpay: "UnionPay",
  visa: "Visa",
};
const WALLETS: Record<string, string> = { apple_pay: "Apple Pay", google_pay: "Google Pay" };
const MASK = "••••";

/**
 * "Visa •••• 4242", "Apple Pay (Visa •••• 4242)", or null when the payment carries no details
 * (an older payment): the caller then says "card".
 */
export function paymentMethodText(method: ReceiptOut["payment_method"]): string | null {
  if (!method?.last4) return null;
  const brand = method.brand ? (BRANDS[method.brand] ?? method.brand) : null;
  const card = [brand, MASK, method.last4].filter(Boolean).join(" ");
  const wallet = method.wallet ? WALLETS[method.wallet] : undefined;
  return wallet ? `${wallet} (${card})` : card;
}

/** The pro's first name for the tip line ("Dan R." -> "Dan"). */
export const proFirstName = (proName: string): string => proName.split(" ")[0] ?? proName;

/** A line's words: never the platform's fee (the API sends none, and there is no key for one). */
export function lineLabel(t: TFunction, line: ReceiptLine, receipt: ReceiptOut): string {
  switch (line.kind) {
    case "service":
      return receipt.category
        ? t("receipt.serviceOf", { category: categoryName(receipt.category) })
        : t("receipt.service");
    case "tax":
      return t("receipt.tax");
    case "tip":
      return t("receipt.tip", { name: proFirstName(receipt.pro_name) });
    case "returned":
      return t("receipt.returned");
  }
}

export const STATUS_TONE: Record<ReceiptStatus, StatusTone> = {
  paid: "success",
  under_review: "warning",
  partly_returned: "info",
  returned: "neutral",
};
