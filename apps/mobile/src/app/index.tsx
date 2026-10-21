import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Screen } from "@/components/ui";

// Placeholder until the real welcome screen (D5.3, #33). No buttons: nothing is behind them yet.
export default function WelcomeScreen() {
  const { t } = useTranslation();

  return (
    <Screen bar="light">
      <View className="flex-1 items-center justify-center gap-4 px-6">
        <View className="h-1 w-12 rounded-pill bg-green-500" />
        <Text className="text-display text-navy-900">{t("brand.name")}</Text>
        <Text className="text-center text-body text-navy-900">{t("brand.tagline")}</Text>
      </View>
    </Screen>
  );
}
