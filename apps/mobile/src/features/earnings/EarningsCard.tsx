import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { ControlIcon } from "@/components/icons";
import { Card, TextSkeleton } from "@/components/ui";
import { useGuardedPush } from "@/features/quotes/navigation";
import { useRefetchOnReturn, useSettledError } from "@/features/quotes/useRequestQuotes";
import { tokens } from "@/theme";

import { earningsSummary, useEarnings, useRefreshEarningsTotals } from "./api";
import { money } from "./format";

export const EARNINGS_HREF = "/pro/earnings";
const CHEVRON = 20;

/**
 * The pro's wallet on the home (#70): what was paid so far, or, before any finished job, where
 * earnings will show. The whole card opens the Earnings screen, whatever its state (a total that
 * did not load is retried there). Asked again on every return to the home, first page only.
 */
export function EarningsCard({ testID = "earnings-card" }: { testID?: string }) {
  const { t } = useTranslation();
  const push = useGuardedPush();
  const { data, error } = useEarnings();
  const shownError = useSettledError(data, error);
  useRefetchOnReturn(useRefreshEarningsTotals());
  const summary = earningsSummary(data);
  const title = t("earnings.card.title");

  let content;
  let description: string;
  if (summary === undefined && shownError === null) {
    content = <TextSkeleton type="title-2" width="40%" testID={`${testID}-loading`} />;
    description = t("earnings.loading");
  } else if (summary === undefined) {
    description = t("earnings.card.error");
    content = <Text className="text-callout text-gray-500">{description}</Text>;
  } else if (data?.pages[0]?.items.length === 0) {
    description = t("earnings.empty.body");
    content = <Text className="text-callout text-gray-500">{description}</Text>;
  } else {
    const paid = money(summary.paid_cents, summary.currency);
    description = `${t("earnings.figure.paid.label")}, ${paid}`;
    content = (
      <View className="flex-row flex-wrap items-baseline gap-x-2">
        <Text className="text-title-2 text-navy-900" testID={`${testID}-paid`}>
          {paid}
        </Text>
        <Text className="text-callout text-gray-500">{t("earnings.figure.paid.label")}</Text>
      </View>
    );
  }

  return (
    <Card
      onPress={() => push(EARNINGS_HREF)}
      accessibilityLabel={`${title}. ${description}`}
      testID={testID}
    >
      <View className="flex-row items-center gap-3">
        <View className="flex-1 gap-1">
          <Text className="text-headline text-navy-900">{title}</Text>
          {content}
        </View>
        <ControlIcon name="chevron" size={CHEVRON} color={tokens.colors["gray-500"]} />
      </View>
    </Card>
  );
}
