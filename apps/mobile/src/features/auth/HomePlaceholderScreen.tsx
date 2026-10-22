import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { logout, useSession, type SessionUser } from "@/api";
import { Button, Screen, StatusBadge, type StatusTone } from "@/components/ui";
import { phoneConfig } from "@/features/phone/config";
import { usePhoneStepOffered } from "@/features/phone/phoneFlow";
import { formatE164 } from "@/features/phone/phoneNumber";

const ROLE_TONE: Record<SessionUser["role"], StatusTone> = {
  customer: "info",
  pro: "brand",
  agent: "neutral",
  admin: "neutral",
};

/**
 * What a signed-in person sees until the real homes land (#43 customer, #38 pro): who they are,
 * as which role, their phone once verified (or the way to verify it), and the way out. The email
 * and the number are shown to their owner only.
 *
 * Right after a sign-up it opens the phone step over itself, once, and shows only its bare page
 * until then: home stays under the step, so "Skip for now" and a verified number both pop back
 * to it. (A gate redirect straight to the step would leave home out of the stack.)
 */
export function HomePlaceholderScreen() {
  const { t } = useTranslation();
  const { user } = useSession();
  const [signingOut, setSigningOut] = useState(false);
  const phoneStepOffered = usePhoneStepOffered();
  const openedPhoneStep = useRef(false);

  useEffect(() => {
    if (!phoneStepOffered || openedPhoneStep.current) return;
    openedPhoneStep.current = true;
    router.push("/verify-phone?from=sign-up");
  }, [phoneStepOffered]);

  if (!user) return null;
  if (phoneStepOffered) {
    return (
      <Screen bar="light" testID="home-screen">
        {null}
      </Screen>
    );
  }

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
        {user.phone_verified && user.phone ? (
          <View className="gap-2" testID="home-phone">
            <Text className="text-callout font-semibold text-navy-900">{t("home.phone")}</Text>
            <View className="flex-row flex-wrap items-center gap-x-3 gap-y-2">
              <Text className="text-body text-navy-900">
                {formatE164(user.phone, phoneConfig.countryCode)}
              </Text>
              <StatusBadge label={t("home.phoneVerified")} tone="success" />
            </View>
          </View>
        ) : null}
        <View className="flex-1" />
        <View className="gap-3">
          {user.phone_verified ? null : (
            <Button
              label={t("home.verifyPhone")}
              size="lg"
              onPress={() => router.push("/verify-phone")}
              testID="home-verify-phone"
            />
          )}
          <Button
            label={t("home.logOut")}
            variant="secondary"
            loading={signingOut}
            onPress={() => void signOut()}
            testID="home-log-out"
          />
        </View>
      </View>
    </Screen>
  );
}
