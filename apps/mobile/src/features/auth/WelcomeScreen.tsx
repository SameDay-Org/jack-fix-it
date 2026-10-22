import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { useSession } from "@/api";
import { Screen } from "@/components/ui";
import { BrandHero } from "@/features/launch/BrandHero";

import { WelcomeActions } from "./components/WelcomeActions";

/**
 * The first screen: the brand hero (the navy hero with the tagline, one lime word, and the support
 * line) and a white bubble below with the two ways in. No other action lives here until its flow
 * exists. The bubble pads the bottom inset itself, so the Screen pads no edge. The hero is the one
 * the launch intro draws, so the intro fades into this screen as one sentence.
 */
export function WelcomeScreen() {
  const { t } = useTranslation();
  const { cleanupPending } = useSession();
  const words = t("launch.words", { returnObjects: true });

  return (
    <Screen bar="hero" edges={[]} testID="welcome-screen">
      <View className="flex-1 bg-navy-900">
        <BrandHero
          word={<Text className="text-display text-green-500">{words[0]}</Text>}
          testID="welcome-headline"
        />
        <WelcomeActions
          cleanupPending={cleanupPending}
          onGetStarted={() => router.push("/(auth)/role")}
          onLogin={() => router.push("/(auth)/login")}
          testID="welcome-actions"
        />
      </View>
    </Screen>
  );
}
