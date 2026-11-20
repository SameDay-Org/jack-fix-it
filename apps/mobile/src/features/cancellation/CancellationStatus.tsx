import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { formatLocale, formatMoneyExact, formatRate } from "@/features/quotes/format";

import type { CancelPreview, JobCancellation } from "./api";

type Money = Pick<JobCancellation, "fee_cents" | "refund_cents" | "refund_status">;

/**
 * What cancelling now costs, in the API's numbers only (`cancel-preview`): free before the pro is
 * on the way, else the fee, its rate as the server's setting gives it, and what comes back.
 */
export function costStatement(
  t: TFunction,
  preview: CancelPreview,
  locale: string = formatLocale(),
): string {
  const money = (cents: number) => formatMoneyExact(cents, locale, preview.currency);
  return preview.fee_applies
    ? t("cancellation.cost.fee", {
        fee: money(preview.fee_cents),
        rate: formatRate(preview.fee_bps, locale),
        amount: money(preview.refund_cents),
      })
    : t("cancellation.cost.free", { amount: money(preview.refund_cents) });
}

/**
 * Where a cancelled job's money stands, in neutral words: what cancelling cost (if anything), then
 * what goes back to the payment method as the API reports it (on its way, back, or not yet with
 * the team looking into it). No timing is promised.
 */
export function moneyLines(
  t: TFunction,
  money: Money,
  currency?: string,
  locale: string = formatLocale(),
): string[] {
  const amount = (cents: number) => formatMoneyExact(cents, locale, currency);
  const back = t(`cancellation.money.${money.refund_status}`, {
    amount: amount(money.refund_cents),
  });
  return money.fee_cents > 0
    ? [t("cancellation.money.fee", { fee: amount(money.fee_cents) }), back]
    : [back];
}

/** The cancelled job's money on its screen: what cancelling cost and where the rest stands. */
export function CancellationStatus({ cancellation }: { cancellation: JobCancellation }) {
  const { t } = useTranslation();
  return (
    <View className="gap-2 border-t border-gray-500/15 pt-4" testID="job-cancellation">
      <Text accessibilityRole="header" className="text-title-2 text-navy-900">
        {t("cancellation.money.title")}
      </Text>
      {moneyLines(t, cancellation).map((line) => (
        <Text key={line} className="text-callout text-gray-500">
          {line}
        </Text>
      ))}
    </View>
  );
}
