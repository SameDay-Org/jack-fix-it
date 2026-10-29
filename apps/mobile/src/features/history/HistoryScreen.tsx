import { router, useIsFocused } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { useSession } from "@/api";
import { TabIcon } from "@/components/icons";
import { Button, Screen, useTabBarInset } from "@/components/ui";
import { tokens, withOpacity } from "@/theme";

// The receipt mark in a circle (docs/design "Iconography": status icons sit in circles), on the
// same faint green-500 wash as the category tiles.
const MARK_SIDE = 88;
const MARK_ICON = 40;
const MARK_TINT = withOpacity("green-500", 0.12);

/**
 * The History tab, until the real list lands (#47): the title for the role and an empty state
 * that says what will appear here and offers the way to make it happen, the Home tab. It is the
 * whole screen, not a card: one record type, one line of copy, one action.
 */
export function HistoryScreen() {
  const { t } = useTranslation();
  const { user } = useSession();
  const focused = useIsFocused();
  const inset = useTabBarInset();

  if (!user) return null;
  const copy = user.role === "customer" ? "customer" : "pro";

  return (
    <Screen bar="light" edges={[]} ownsStatusBar={focused} testID="history-screen">
      <View className="flex-1 px-4 pt-6" style={{ paddingBottom: inset }}>
        <Text accessibilityRole="header" className="text-title-1 text-navy-900">
          {t(`history.${copy}.title`)}
        </Text>
        <View className="flex-1 items-center justify-center gap-6 pb-12" testID="history-empty">
          <View
            className="items-center justify-center rounded-pill"
            style={{ width: MARK_SIDE, height: MARK_SIDE, backgroundColor: MARK_TINT }}
          >
            <TabIcon name="history" size={MARK_ICON} color={tokens.colors["navy-900"]} accent />
          </View>
          <Text className="text-center text-body text-gray-500">{t(`history.${copy}.empty`)}</Text>
          <Button
            label={t(`history.${copy}.cta`)}
            onPress={() => router.navigate("/")}
            testID="history-go-home"
          />
        </View>
      </View>
    </Screen>
  );
}
