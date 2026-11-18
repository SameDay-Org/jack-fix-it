import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Button, Card } from "@/components/ui";
import { useGuardedPush } from "@/features/quotes/navigation";

import { PAYOUTS_HREF } from "./links";

/**
 * "Finish payout setup" (#277), shown to an approved pro whose payouts are not on yet: on the
 * pro's home and on the verification screen. One line on why, and the way to the payout screen,
 * where the setup starts. It asks the API for nothing: the status is Stripe's to give, and only
 * the payout screen asks for it.
 */
export function PayoutSetupCard({
  primary = true,
  testID = "payout-setup",
}: {
  /** Whether its button is the screen's primary action: not while another card's is. */
  primary?: boolean;
  testID?: string;
}) {
  const { t } = useTranslation();
  const push = useGuardedPush();
  return (
    <Card testID={testID}>
      <View className="gap-4">
        <View className="gap-1">
          <Text accessibilityRole="header" className="text-headline text-navy-900">
            {t("proPayouts.card.title")}
          </Text>
          <Text className="text-callout text-gray-500">{t("proPayouts.card.body")}</Text>
        </View>
        <Button
          label={t("proPayouts.card.action")}
          variant={primary ? "primary" : "secondary"}
          onPress={() => push(PAYOUTS_HREF)}
          testID={`${testID}-action`}
        />
      </View>
    </Card>
  );
}
