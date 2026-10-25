import { Trans, useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { useSession } from "@/api";
import { Screen, StatusBadge } from "@/components/ui";
import { AccountActions } from "@/features/account/AccountActions";
import { ROLE_TONE } from "@/features/account/identity";
import { PhoneStatus } from "@/features/account/PhoneStatus";
import { useOpenPhoneStepAfterSignUp } from "@/features/phone/useOpenPhoneStepAfterSignUp";

/**
 * What a signed-in pro (or staff member) sees until their home lands (#38): who they are, as which
 * role, their phone once verified (or the way to verify it), and the way out. The email and the
 * number are shown to their owner only.
 *
 * Right after a sign-up it opens the phone step over itself, once, and shows only its bare page
 * until then (`useOpenPhoneStepAfterSignUp`).
 */
export function HomePlaceholderScreen() {
  const { t } = useTranslation();
  const { user } = useSession();
  const phoneStepOffered = useOpenPhoneStepAfterSignUp();

  if (!user) return null;
  if (phoneStepOffered) {
    return (
      <Screen bar="light" testID="home-screen">
        {null}
      </Screen>
    );
  }

  return (
    <Screen bar="light" testID="home-screen">
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
    </Screen>
  );
}
