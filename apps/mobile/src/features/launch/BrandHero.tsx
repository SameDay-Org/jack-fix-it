import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";

import { tokens } from "@/theme";

import { splitHeadline } from "./headline";

type BrandHeroProps = {
  /** The headline's rolling word: a `WordRotator`, or a plain green word for a static frame. */
  word: ReactNode;
  /** The headline's test id; the gauge takes `-gauge`. */
  testID?: string;
};

const WORD_CLASS = "text-display text-white";
// Until the font's space is measured: a quarter of the type size, close to most fonts' space.
const SPACE_FALLBACK = tokens.fontSize.display.size / 4;

type Gauge = { pair?: number; single?: number };

/**
 * The brand hero Welcome, the launch intro and the gate's restoring frame all draw: the wordmark
 * as text (no logo yet, #8), the headline and the support line, centered in whatever height the
 * screen gives it. One component, so the three never drift apart and the intro can fade into
 * Welcome as one sentence.
 *
 * The headline is a wrapping row of words so the rolling word can be its own element. The gap
 * between words is the font's own space, measured from two hidden texts ("x x" minus "xx"), so
 * the row breaks lines where one Text with spaces would. Screen readers get one static label
 * with the first word; the row's children are hidden from them.
 */
export function BrandHero({ word, testID }: BrandHeroProps) {
  const { t } = useTranslation();
  const { width: windowWidth } = useWindowDimensions();
  const words = t("launch.words", { returnObjects: true });
  const parts = splitHeadline((placeholder) => t("launch.headline", { word: placeholder }));
  const [gauge, setGauge] = useState<Gauge>({});
  const spaceWidth =
    gauge.pair !== undefined && gauge.single !== undefined
      ? Math.max(0, gauge.pair - gauge.single)
      : SPACE_FALLBACK;

  const measure = (key: keyof Gauge) => (event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setGauge((current) => (current[key] === width ? current : { ...current, [key]: width }));
  };

  return (
    <View className="flex-1 justify-center gap-6 px-6">
      <View className="gap-3">
        <View className="h-1 w-12 rounded-pill bg-green-500" />
        <Text className="text-headline text-white">{t("brand.name")}</Text>
      </View>
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={t("launch.headline", { word: words[0] })}
        className="flex-row flex-wrap items-end"
        style={{ columnGap: spaceWidth }}
        testID={testID}
      >
        {parts.before.map((piece, index) => (
          <Text key={`b${index}`} className={WORD_CLASS}>
            {piece}
          </Text>
        ))}
        <View className="flex-row items-end">
          {parts.attachedBefore ? <Text className={WORD_CLASS}>{parts.attachedBefore}</Text> : null}
          {word}
          {parts.attachedAfter ? <Text className={WORD_CLASS}>{parts.attachedAfter}</Text> : null}
        </View>
        {parts.after.map((piece, index) => (
          <Text key={`a${index}`} className={WORD_CLASS}>
            {piece}
          </Text>
        ))}
      </View>
      <Text className="text-body text-white">{t("welcome.support")}</Text>
      {/* The space gauge. Absolute with an explicit width: an absolute child without one is measured
          against its parent, and a column stretches its children (see WordRotator). */}
      <View
        pointerEvents="none"
        style={{ position: "absolute", opacity: 0, alignItems: "flex-start", width: windowWidth }}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        testID={testID && `${testID}-gauge`}
      >
        <Text className={WORD_CLASS} numberOfLines={1} onLayout={measure("pair")}>
          x x
        </Text>
        <Text className={WORD_CLASS} numberOfLines={1} onLayout={measure("single")}>
          xx
        </Text>
      </View>
    </View>
  );
}
