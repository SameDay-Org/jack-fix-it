import { useIsFocused } from "expo-router";
import { Trans, useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { useSession } from "@/api";
import { Screen, StatusBadge, useTabBarInset } from "@/components/ui";
import { AccountActions } from "@/features/account/AccountActions";
import { ROLE_TONE } from "@/features/account/identity";
import { PhoneStatus } from "@/features/account/PhoneStatus";
import { useOpenPhoneStepAfterSignUp } from "@/features/phone/useOpenPhoneStepAfterSignUp";

/**
 * What a signed-in pro (or staff member) sees on the Home tab until their home lands (#38): who
 * they are, as which role, their phone once verified (or the way to verify it), and the way out. The email and the
 * number are shown to their owner only.
 *
 * Right after a sign-up it opens the phone step over itself, once, and shows only its bare page
 * until then (`useOpenPhoneStepAfterSignUp`).
 */
export function HomePlaceholderScreen() {
  const { t } = useTranslation();
  const { user } = useSession();
  const phoneStepOffered = useOpenPhoneStepAfterSignUp();
  // Tabs stay mounted while another one shows: only the focused tab owns the status bar.
  const focused = useIsFocused();
  const inset = useTabBarInset();

  if (!user) return null;
  if (phoneStepOffered) {
    return (
      <Screen bar="light" ownsStatusBar={focused} testID="home-screen">
        {null}
      </Screen>
    );
  }

  // No bottom edge: the page pads the tab bar itself, so the actions at its foot stay reachable.
  return (
    <Screen bar="light" edges={[]} ownsStatusBar={focused} testID="home-screen">
      <View className="flex-1" style={{ paddingBottom: inset }}>
        <View className="flex-1 gap-6 px-4 pb-4 pt-6">
          <View className="gap-3">
            <Text className="text-title-1 text-navy-900" testID="home-welcome">
              <Trans
                i18nKey="home.welcome"
                values={{ email: user.email }}
                components={{ email: <Text className="text-title-2 text-gray-500" /> }}
              />
            </Text>
            <StatusBadge
              label={t(`roles.${user.role}`)}
              tone={ROLE_TONE[user.role]}
              testID="home-role"
            />
            <Text className="text-body text-gray-500">{t("home.comingSoon")}</Text>
          </View>
          <PhoneStatus user={user} testID="home-phone" />
          <View className="flex-1" />
          <AccountActions user={user} testID="home" />
        </View>
      </View>
    </Screen>
  );
}
