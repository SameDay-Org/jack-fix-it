import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Card, StatusBadge, StatusBadgeSkeleton, TextSkeleton } from "@/components/ui";

import { earningTipCents } from "@/features/tips/api";

import type { Earning } from "./api";
import { earningDates, earningLabel, earningTitle, money, STATUS_TONE } from "./format";

export type EarningRowProps = {
  item: Earning;
  /** The summary's currency: the rows carry none of their own. */
  currency: string;
  /** When the answer came in: a date shows its year only when it is not this one. */
  now: number;
};

// What the job was and the amount share a line while both fit; past that (a long name, a large
// font) the amount wraps under the name instead of squeezing it, still at the right edge with
// the tip under it (its column grows to the line), in line with the amounts of the other rows.
const TOP_LINE = "flex-row flex-wrap justify-between gap-x-3 gap-y-1";

/**
 * One finished job: what it was, what the pro receives, where the money stands (a chip whose
 * words carry the status) and the date that matters for it. No customer detail: the API sends
 * none and the row would show none. Read as one line by assistive technology.
 */
export function EarningRow({ item, currency, now }: EarningRowProps) {
  const { t } = useTranslation();
  // The customer's tip (#273), 100% the pro's, under the job's amount and read with the row.
  const tipCents = earningTipCents(item);
  const tip = tipCents > 0 ? t("earnings.row.tip", { amount: money(tipCents, currency) }) : null;
  const label = earningLabel(t, item, currency, now);
  return (
    <Card testID={`earning-${item.job_id}`}>
      <View accessible accessibilityLabel={tip ? `${label}, ${tip}` : label} className="gap-2">
        <View className={TOP_LINE}>
          <Text className="text-headline text-navy-900">{earningTitle(t, item)}</Text>
          <View className="grow items-end">
            <Text className="text-headline text-navy-900">
              {money(item.amount_cents, currency)}
            </Text>
            {tip ? (
              <Text className="text-footnote text-gray-500" testID={`earning-${item.job_id}-tip`}>
                {tip}
              </Text>
            ) : null}
          </View>
        </View>
        <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
          <StatusBadge
            label={t(`earnings.status.${item.status}`)}
            tone={STATUS_TONE[item.status]}
            testID={`earning-${item.job_id}-status`}
          />
          {earningDates(t, item, now).map((line) => (
            <Text key={line} className="text-footnote text-gray-500">
              {line}
            </Text>
          ))}
        </View>
      </View>
    </Card>
  );
}

/** A row's placeholder with the loaded row's lines, hidden from assistive technology. */
export function EarningRowSkeleton({ testID }: { testID?: string }) {
  const { t } = useTranslation();
  return (
    <Card testID={testID}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="gap-2"
      >
        <View className="flex-row gap-3">
          <TextSkeleton type="headline" width="60%" className="flex-1" />
          <TextSkeleton type="headline" className="w-1/4" />
        </View>
        <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
          <StatusBadgeSkeleton label={t("earnings.status.paid")} />
          <TextSkeleton type="footnote" width="35%" className="flex-1" />
        </View>
      </View>
    </Card>
  );
}
