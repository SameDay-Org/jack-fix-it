import { router, useIsFocused } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { useSession } from "@/api";
import { TabIcon } from "@/components/icons";
import { Button, ICON_TILE, ICON_TILE_TINT, Screen, useTabBarInset } from "@/components/ui";
import { tokens } from "@/theme";

import { RequestList } from "./RequestList";

// The receipt mark in a circle (docs/design "Iconography": status icons sit in circles), at the
// large tile's size and on the tiles' green-500 wash.
const MARK = ICON_TILE.lg;

type Copy = "customer" | "pro";

/**
 * The History tab. A customer sees their requests (#47), and the empty state until they send
 * one. A pro (and staff) still see the empty state alone: their jobs come with jobs and payment.
 * The empty state is the whole screen, not a card: one record type, one line of copy, one action.
 */
export function HistoryScreen() {
  const { user } = useSession();
  const focused = useIsFocused();
  const inset = useTabBarInset();

  if (!user) return null;
  const copy: Copy = user.role === "customer" ? "customer" : "pro";

  return (
    <Screen bar="light" edges={[]} ownsStatusBar={focused} testID="history-screen">
      {copy === "customer" ? (
        <View className="flex-1" style={{ paddingBottom: inset }}>
          <RequestList
            header={
              <View className="px-4 pb-3 pt-6">
                <HistoryTitle copy={copy} />
              </View>
            }
            empty={<HistoryEmpty copy={copy} className="px-4" />}
          />
        </View>
      ) : (
        <View className="flex-1 px-4 pt-6" style={{ paddingBottom: inset }}>
          <HistoryTitle copy={copy} />
          <HistoryEmpty copy={copy} />
        </View>
      )}
    </Screen>
  );
}

function HistoryTitle({ copy }: { copy: Copy }) {
  const { t } = useTranslation();
  return (
    <Text accessibilityRole="header" className="text-title-1 text-navy-900">
      {t(`history.${copy}.title`)}
    </Text>
  );
}

/** What will appear here, and the way to make it happen: the Home tab. */
function HistoryEmpty({ copy, className = "" }: { copy: Copy; className?: string }) {
  const { t } = useTranslation();
  return (
    <View
      className={`flex-1 items-center justify-center gap-6 pb-12 ${className}`}
      testID="history-empty"
    >
      <View
        className="items-center justify-center rounded-pill"
        style={{ width: MARK.side, height: MARK.side, backgroundColor: ICON_TILE_TINT }}
      >
        <TabIcon name="history" size={MARK.icon} color={tokens.colors["navy-900"]} accent />
      </View>
      <Text className="text-center text-body text-gray-500">{t(`history.${copy}.empty`)}</Text>
      <Button
        label={t(`history.${copy}.cta`)}
        onPress={() => router.navigate("/")}
        testID="history-go-home"
      />
    </View>
  );
}
