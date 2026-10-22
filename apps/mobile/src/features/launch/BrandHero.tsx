import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";

import { tokens } from "@/theme";

import { layoutLines, splitHeadline, type HeadlineToken } from "./headline";

type BrandHeroProps = {
  /** The headline's rolling word: a `WordRotator`, or a plain green word for a static frame. */
  word: ReactNode;
  /** Called once, when the headline's rows are laid out natively: the hero's first final frame. */
  onLaidOut?: () => void;
  /**
   * The headline's test id; its lines take `-line-N`, the word slot `-word`, the gauge `-gauge`,
   * the whole hero `-frame`.
   */
  testID?: string;
};

const WORD_CLASS = "text-display text-white";
const GAUGE_PAIR = "x x";
const GAUGE_SINGLE = "xx";

type Sizes = Record<string, { width: number; height: number }>;

// Measurements outlive the instance: the gate's hero, the intro's and Welcome's draw the same words
// at the same size, so the second and third lay their lines out on their first commit instead of
// measuring (transparent) for a frame of their own. Keyed by language, window width and font scale.
const measuredSizes = new Map<string, Sizes>();
const measuredRowWidths = new Map<string, number>();

/** Forgets the measurements shared across heroes; tests render many, at different widths. */
export function resetHeroMeasurementsForTests() {
  measuredSizes.clear();
  measuredRowWidths.clear();
}

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
export function BrandHero({ word, onLaidOut, testID }: BrandHeroProps) {
  const { t, i18n } = useTranslation();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const words = t("launch.words", { returnObjects: true });
  const parts = splitHeadline((placeholder) => t("launch.headline", { word: placeholder }));
  const cacheKey = `${i18n.language}:${windowWidth}:${fontScale}`;
  const [sizes, setSizes] = useState<Sizes>(() => measuredSizes.get(cacheKey) ?? {});
  const [rowWidth, setRowWidth] = useState<number | undefined>(() =>
    measuredRowWidths.get(cacheKey),
  );

  const record = (key: string) => (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSizes((current) => {
      if (current[key]?.width === width && current[key]?.height === height) return current;
      const next = { ...current, [key]: { width, height } };
      measuredSizes.set(cacheKey, next);
      return next;
    });
  };
  const onRowLayout = ({ nativeEvent }: LayoutChangeEvent) => {
    measuredRowWidths.set(cacheKey, nativeEvent.layout.width);
    setRowWidth(nativeEvent.layout.width);
  };
  // Reported from the first row's own layout event, not from the commit that renders it: on a slow
  // device the native mount trails the commit, and a flag set from JS would be early.
  const laidOutRef = useRef(false);
  const onFirstLineLayout = () => {
    if (laidOutRef.current) return;
    laidOutRef.current = true;
    onLaidOut?.();
  };

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

  // Transparent until the lines are laid out, in the same commit as the lines: the wrapping
  // fallback below is never painted, so the hero never shows a layout it then jumps away from.
  return (
    <View
      className="flex-1 justify-center gap-6 px-6"
      style={{ opacity: lines ? 1 : 0 }}
      testID={testID && `${testID}-frame`}
    >
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
              onLayout={index === 0 ? onFirstLineLayout : undefined}
              testID={testID && `${testID}-line-${index}`}
            >
              {line.map(token)}
            </View>
          ))
        ) : (
          // Until everything is measured: a wrapping row, transparent (see above), that gives the
          // header its width and about its height.
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
