import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { logout, useSession, type SessionUser } from "@/api";
import { Button, Screen, StatusBadge, type StatusTone } from "@/components/ui";

const ROLE_TONE: Record<SessionUser["role"], StatusTone> = {
  customer: "info",
  pro: "brand",
  agent: "neutral",
  admin: "neutral",
};

/**
 * What a signed-in person sees until the real homes land (#43 customer, #38 pro): who they are,
 * as which role, and the way out. The email is shown to its owner only.
 */
export function HomePlaceholderScreen() {
  const { t } = useTranslation();
  const { user } = useSession();
  const [signingOut, setSigningOut] = useState(false);

  if (!user) return null;

  // The gate leaves this screen as soon as the sign-out begins; a failed local delete is shown on
  // welcome through `cleanupPending`.
  const signOut = async () => {
    setSigningOut(true);
    try {
      await logout();
    } catch {
      // Surfaced on welcome.
    } finally {
      setSigningOut(false);
    }
  };

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
        <View className="flex-1" />
        <Button
          label={t("home.logOut")}
          variant="secondary"
          loading={signingOut}
          onPress={() => void signOut()}
          testID="home-log-out"
        />
      </View>
    </Screen>
  );
}
