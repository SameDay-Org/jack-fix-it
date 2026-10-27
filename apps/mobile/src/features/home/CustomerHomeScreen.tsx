import { Trans, useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";

import { useSession } from "@/api";
import { Button, Screen } from "@/components/ui";
import { AccountButton } from "@/features/account/AccountButton";
import { useOpenPhoneStepAfterSignUp } from "@/features/phone/useOpenPhoneStepAfterSignUp";
import { startRequest } from "@/features/request";

import { CategoryChips } from "./CategoryChips";

/**
 * The customer's home: a navy hero that asks what is going on and offers one action, telling
 * Jack what happened; the categories below are the secondary way in. Both start a request.
 *
 * Right after a sign-up it opens the phone step over itself, once, and shows only its bare page
 * until then (`useOpenPhoneStepAfterSignUp`).
 */
export function CustomerHomeScreen() {
  const { t } = useTranslation();
  const { user } = useSession();
  const phoneStepOffered = useOpenPhoneStepAfterSignUp();

  if (!user) return null;
  if (phoneStepOffered) {
    return (
      <Screen bar="light" testID="customer-home">
        {null}
      </Screen>
    );
  }

  // No bottom edge: the categories panel pads the home indicator itself.
  return (
    <Screen bar="hero" edges={[]} testID="customer-home">
      <ScrollView contentContainerClassName="flex-grow">
        <View className="gap-6 px-4 pb-8 pt-2">
          <View className="items-end">
            <AccountButton user={user} />
          </View>
          <View className="gap-3">
            <Text accessibilityRole="header" className="text-display text-white">
              <Trans
                i18nKey="home.headline"
                components={{ accent: <Text className="text-green-500" /> }}
              />
            </Text>
            <Text className="text-body text-white">{t("home.support")}</Text>
          </View>
          <Button
            label={t("home.tellJack")}
            size="lg"
            onPress={() => startRequest(null)}
            testID="home-tell-jack"
          />
        </View>
        <CategoryChips />
      </ScrollView>
    </Screen>
  );
}
