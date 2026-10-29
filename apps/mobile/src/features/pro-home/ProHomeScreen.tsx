import { useIsFocused } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { useSession } from "@/api";
import { Screen, useTabBarInset } from "@/components/ui";
import { useOpenPhoneStepAfterSignUp } from "@/features/phone/useOpenPhoneStepAfterSignUp";

import { OpportunityList } from "./OpportunityList";

/**
 * The pro's home (#219), the Home tab: a greeting, then the new opportunities,
 * which scroll the header along. The wallet (#70) and the current job (#63) come later.
 *
 * Right after a sign-up it opens the phone step over itself, once, and shows only its bare page
 * until then (`useOpenPhoneStepAfterSignUp`).
 */
export function ProHomeScreen() {
  const { t } = useTranslation();
  const { user } = useSession();
  const phoneStepOffered = useOpenPhoneStepAfterSignUp();
  // Tabs stay mounted while another one shows: only the focused tab owns the status bar.
  const focused = useIsFocused();
  const inset = useTabBarInset();

  if (!user) return null;
  if (phoneStepOffered) {
    return (
      <Screen bar="light" ownsStatusBar={focused} testID="pro-home">
        {null}
      </Screen>
    );
  }

  const firstName = user.first_name?.trim();
  return (
    // No bottom edge: the page pads the tab bar itself.
    <Screen bar="light" edges={[]} ownsStatusBar={focused} testID="pro-home">
      <View className="flex-1" style={{ paddingBottom: inset }}>
        <OpportunityList
          header={
            <View className="gap-6 pb-4 pt-2">
              <Text
                accessibilityRole="header"
                className="text-title-1 text-navy-900"
                testID="pro-home-greeting"
              >
                {firstName
                  ? t("opportunities.greeting", { name: firstName })
                  : t("opportunities.greetingNoName")}
              </Text>
              <Text accessibilityRole="header" className="text-headline text-navy-900">
                {t("opportunities.title")}
              </Text>
            </View>
          }
        />
      </View>
    </Screen>
  );
}
