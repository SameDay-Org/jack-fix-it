import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button, Screen } from "@/components/ui";

import { splitHeadline } from "./headline";

type LaunchHeroProps = {
  /** The rolling word's element: a `WordRotator`, or a plain green word for the static frame. */
  word: ReactNode;
  /** Optional skip control, bottom right. */
  skip?: { label: string; onPress: () => void };
  testID?: string;
};

/**
 * The launch frame: full-bleed navy, the wordmark as text (no logo yet, #8) and the headline laid
 * out as a wrapping row of words so the rolling word can be its own element while the sentence
 * wraps naturally. Screen readers get one static label with the first word; the row's children
 * are hidden from them.
 */
export function LaunchHero({ word, skip, testID }: LaunchHeroProps) {
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const words = t("launch.words", { returnObjects: true });
  const parts = splitHeadline((placeholder) => t("launch.headline", { word: placeholder }));

  return (
    <Screen bar="hero" edges={[]} testID={testID}>
      <View className="flex-1 bg-navy-900" style={{ paddingBottom: bottom }}>
        <View className="flex-1 justify-center gap-6 px-6">
          <View className="gap-3">
            <View className="h-1 w-12 rounded-pill bg-green-500" />
            <Text className="text-headline text-white">{t("brand.name")}</Text>
          </View>
          <View
            accessible
            accessibilityRole="header"
            accessibilityLabel={t("launch.headline", { word: words[0] })}
            className="flex-row flex-wrap items-end gap-x-2"
            testID={testID && `${testID}-headline`}
          >
            {parts.before.map((piece, index) => (
              <Text key={`b${index}`} className="text-display text-white">
                {piece}
              </Text>
            ))}
            <View className="flex-row items-end">
              {parts.attachedBefore ? (
                <Text className="text-display text-white">{parts.attachedBefore}</Text>
              ) : null}
              {word}
              {parts.attachedAfter ? (
                <Text className="text-display text-white">{parts.attachedAfter}</Text>
              ) : null}
            </View>
            {parts.after.map((piece, index) => (
              <Text key={`a${index}`} className="text-display text-white">
                {piece}
              </Text>
            ))}
          </View>
        </View>
        {skip ? (
          <View className="flex-row justify-end px-4 pb-4">
            <Button
              label={skip.label}
              variant="ghost"
              onPress={skip.onPress}
              className="bg-white/10"
              testID={testID && `${testID}-skip`}
            />
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
