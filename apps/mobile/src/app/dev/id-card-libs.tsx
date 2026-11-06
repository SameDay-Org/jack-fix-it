// Dev-only: the ID card libraries smoke screen (#251), each native library of #250 proving it
// loads on this build. Unreachable outside __DEV__; the sample strings are literal on purpose.
import { Redirect } from "expo-router";
import { ScrollView, Text, View } from "react-native";

import { IdCardLibsSample } from "@/components/dev/IdCardLibsSample";
import { Screen } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";

export default function IdCardLibsScreen() {
  if (!__DEV__) return <Redirect href="/" />;

  return (
    <Screen bar="light">
      <ScrollView contentContainerClassName="gap-6 px-4 pb-8 pt-2">
        <BackButton />
        <View className="gap-2">
          <Text accessibilityRole="header" className="text-title-1 text-navy-900">
            ID card libraries
          </Text>
          <Text className="text-callout text-gray-500">
            Camera preview, card snapshot, share sheet, gyroscope and haptics: the natives behind
            the ID card.
          </Text>
        </View>
        <IdCardLibsSample />
      </ScrollView>
    </Screen>
  );
}
