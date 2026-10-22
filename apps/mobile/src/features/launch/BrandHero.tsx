import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";

import { tokens } from "@/theme";

import { layoutLines, splitHeadline, type HeadlineToken } from "./headline";

type BrandHeroProps = {
  /** The headline's rolling word: a `WordRotator`, or a plain green word for a static frame. */
  word: ReactNode;
  /** The headline's test id; its lines take `-line-N`, the word slot `-word`, the gauge `-gauge`. */
  testID?: string;
};

const WORD_CLASS = "text-display text-white";
const GAUGE_PAIR = "x x";
const GAUGE_SINGLE = "xx";

type Sizes = Record<string, { width: number; height: number }>;

/**
 * The brand hero Welcome, the launch intro and the gate's restoring frame all draw: the wordmark
 * as text (no logo yet, #8), the headline and the support line, centered in whatever height the
 * screen gives it. One component, so the three never drift apart and the intro can fade into
 * Welcome as one sentence.
 *
 * The headline's lines are laid out here, not by flex-wrap: every word (and every word the rotator
 * can show) is measured in a hidden row, the lines are broken as one Text with spaces would, with
 * the rolling word's slot counted at its widest, and each line is a fixed-height row. So the line
 * breaks and the block height are the same at rest and through every swap, at any font scale,
 * while the words after the slot still follow the word's width as it rolls. Screen readers get one
 * static label with the first word and nothing else.
 */
export function BrandHero({ word, testID }: BrandHeroProps) {
  const { t } = useTranslation();
  const { width: windowWidth } = useWindowDimensions();
  const words = t("launch.words", { returnObjects: true });
  const parts = splitHeadline((placeholder) => t("launch.headline", { word: placeholder }));
  const [sizes, setSizes] = useState<Sizes>({});
  const [rowWidth, setRowWidth] = useState<number>();

  const record = (key: string) => (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSizes((current) =>
      current[key]?.width === width && current[key]?.height === height
        ? current
        : { ...current, [key]: { width, height } },
    );
  };
  const onRowLayout = ({ nativeEvent }: LayoutChangeEvent) => setRowWidth(nativeEvent.layout.width);

  const widthOf = (text: string) => sizes[text]?.width;
  const space =
    sizes[GAUGE_PAIR] && sizes[GAUGE_SINGLE]
      ? Math.max(0, sizes[GAUGE_PAIR].width - sizes[GAUGE_SINGLE].width)
      : undefined;
  const widest = words
    .map(widthOf)
    .reduce<number | undefined>(
      (max, width) => (max === undefined || width === undefined ? undefined : Math.max(max, width)),
      0,
    );
  const glued = [parts.attachedBefore, parts.attachedAfter].filter(Boolean);
  const gluedWidth = glued.reduce<number | undefined>(
    (sum, text) =>
      sum === undefined || widthOf(text) === undefined ? undefined : sum + widthOf(text)!,
    0,
  );
  const lineHeight = Math.max(
    tokens.fontSize.display.lineHeight,
    ...Object.values(sizes).map((s) => s.height),
  );
  const lines =
    rowWidth !== undefined &&
    space !== undefined &&
    widest !== undefined &&
    gluedWidth !== undefined
      ? layoutLines(parts, {
          wordWidth: widthOf,
          slotWidth: widest + gluedWidth,
          space,
          maxWidth: rowWidth,
        })
      : null;

  const piece = (text: string, key: string) => (
    <Text key={key} className={WORD_CLASS} importantForAccessibility="no">
      {text}
    </Text>
  );
  const slot = (
    <View
      key="slot"
      className="flex-row items-end"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      testID={testID && `${testID}-word`}
    >
      {parts.attachedBefore ? piece(parts.attachedBefore, "ab") : null}
      {word}
      {parts.attachedAfter ? piece(parts.attachedAfter, "aa") : null}
    </View>
  );
  const token = (item: HeadlineToken, index: number) =>
    item.kind === "slot" ? slot : piece(item.text, `w${index}`);
  const measured = [...parts.before, ...parts.after, ...glued, ...words, GAUGE_PAIR, GAUGE_SINGLE];

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
        onLayout={onRowLayout}
        testID={testID}
      >
        {lines ? (
          lines.map((line, index) => (
            <View
              key={`l${index}`}
              className="flex-row items-end"
              style={{ columnGap: space, height: lineHeight }}
              testID={testID && `${testID}-line-${index}`}
            >
              {line.map(token)}
            </View>
          ))
        ) : (
          // Until everything is measured (one frame, under the splash or the intro): the row wraps.
          <View
            className="flex-row flex-wrap items-end"
            style={{ columnGap: tokens.fontSize.display.size / 4 }}
          >
            {parts.before.map((text, index) => piece(text, `b${index}`))}
            {slot}
            {parts.after.map((text, index) => piece(text, `a${index}`))}
          </View>
        )}
      </View>
      <Text className="text-body text-white">{t("welcome.support")}</Text>
      {/* The measurement row: every word the headline can show, and the space gauge. Absolute with an
          explicit width and start-aligned items: an absolute child without a width is measured against
          its parent, and a column stretches its children (see WordRotator). */}
      <View
        pointerEvents="none"
        style={{ position: "absolute", opacity: 0, alignItems: "flex-start", width: windowWidth }}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        testID={testID && `${testID}-gauge`}
      >
        {[...new Set(measured)].map((text) => (
          <Text key={text} className={WORD_CLASS} numberOfLines={1} onLayout={record(text)}>
            {text}
          </Text>
        ))}
      </View>
    </View>
  );
}
