import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";

import { useSession } from "@/api";
import { ListGroup, ListRow, Screen, StatusBadge } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";
import { NotificationsSettingRow } from "@/features/notifications";

import { cardDetails } from "./identity";
import { LanguageSection } from "./LanguageSection";

/**
 * Settings (#293): what the Account tab used to list about the person, shown to them only (the
 * email they sign in with, and the phone: the verified number, or the way to verify it), the
 * app's language (#218), then whether notifications are on, and the way to turn them on (#334).
 * The notification kinds arrive with the rest of #218.
 */
export function SettingsScreen() {
  const { t } = useTranslation();
  const { user } = useSession();
  if (!user) return null;
  const { phone } = cardDetails(user);

  return (
    <Screen bar="light" testID="settings-screen">
      <ScrollView contentContainerClassName="gap-6 px-4 pb-6 pt-2">
        <View className="gap-2">
          <BackButton fallbackHref="/account" />
          <Text accessibilityRole="header" className="text-title-1 text-navy-900">
            {t("settings.title")}
          </Text>
        </View>
        <View className="gap-3">
          <Text className="text-footnote font-semibold uppercase text-gray-500">
            {t("settings.sections.account")}
          </Text>
          <ListGroup testID="settings-account">
            <ListRow label={t("settings.email")} value={user.email} testID="settings-email" />
            {phone ? (
              <ListRow
                label={t("settings.phone")}
                value={phone}
                accessory={<StatusBadge label={t("home.phoneVerified")} tone="success" />}
                testID="settings-phone"
              />
            ) : (
              <ListRow
                label={t("home.verifyPhone")}
                value={t("settings.phoneNotVerified")}
                onPress={() => router.push("/verify-phone")}
                testID="settings-verify-phone"
              />
            )}
          </ListGroup>
        </View>
        <LanguageSection user={user} />
        <View className="gap-3">
          <Text className="text-footnote font-semibold uppercase text-gray-500">
            {t("settings.sections.notifications")}
          </Text>
          <ListGroup testID="settings-notifications-group">
            <NotificationsSettingRow />
          </ListGroup>
        </View>
      </ScrollView>
    </Screen>
  );
}
