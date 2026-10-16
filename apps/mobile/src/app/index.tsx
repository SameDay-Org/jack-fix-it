import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// Placeholder until the real welcome screen (D5.3, #33). No buttons: nothing is behind them yet.
export default function WelcomeScreen() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-gray-light">
      <SafeAreaView style={{ flex: 1 }}>
        <View className="flex-1 items-center justify-center gap-4 px-6">
          <View className="h-1 w-12 rounded-full bg-orange" />
          <Text className="text-4xl font-semibold text-navy">{t("brand.name")}</Text>
          <Text className="text-center text-lg text-navy">{t("brand.tagline")}</Text>
        </View>
      </SafeAreaView>
    </View>
  );
}
