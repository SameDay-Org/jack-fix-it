import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Card, StatusBadge } from "@/components/ui";

/**
 * Where payout setup will be (#277): its name, a pill that says it is not available yet, and one
 * line on what it is for. A placeholder, labelled as one: nothing in it is a control.
 */
export function PayoutSetupPlaceholder({ testID = "payout-setup" }: { testID?: string }) {
  const { t } = useTranslation();
  return (
    <Card testID={testID}>
      <View className="gap-2">
        <View className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <Text className="shrink text-headline text-navy-900">
            {t("proVerification.approved.placeholder.title")}
          </Text>
          <StatusBadge label={t("proVerification.approved.placeholder.badge")} tone="neutral" />
        </View>
        <Text className="text-callout text-gray-500">
          {t("proVerification.approved.placeholder.body")}
        </Text>
      </View>
    </Card>
  );
}
