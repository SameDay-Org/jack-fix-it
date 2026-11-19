import { useEffect, useState } from "react";
import { PixelRatio, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { tokens } from "@/theme";

import { cx } from "./cx";

export type MilestonesProps = {
  /** One short label per milestone, left to right ("On the way", "Working", "Done"). */
  labels: readonly string[];
  /** How many milestones are reached, from 0 (none yet) to `labels.length`. */
  reached: number;
  /** The progress bar's spoken name ("Job progress"). */
  label: string;
  /** The spoken value ("Step 2 of 3, Working"); the screen announces changes itself. */
  valueText: string;
  testID?: string;
};

const { stepSlideMs } = tokens.motion;
const MIN_LABEL_SCALE = 0.6;
const LABEL_FONT_SIZE = tokens.fontSize.footnote.size;
// React Native ignores a font cap under 1: there, each label's own shrink is what is left.
const MIN_MULTIPLIER = 1;
// Just under the whole pixel, so the size Android rounds up to (ceil) is the one computed.
const PIXEL_EPSILON = 0.01;

/**
 * The font multiplier every label shares, so at large text they shrink together instead of one
 * by one (#486: "On the way" drawn smaller than "Working" and "Done"): the largest at which the
 * widest label still fits its column, in whole pixels. `widths` are the labels' widths at no font
 * scaling; undefined until the column and every label are measured, or when one measures 0.
 */
export function sharedLabelMultiplier(
  column: number,
  widths: readonly (number | undefined)[],
  fontSize: number,
  density: number,
): number | undefined {
  if (!(column > 0) || widths.length === 0) return undefined;
  if (widths.some((width) => width === undefined || !(width > 0))) return undefined;
  // The label's size in pixels at no font scaling (React Native rounds it up).
  const unscaled = Math.ceil(fontSize * density);
  const fit = Math.min(...widths.map((width) => column / (width as number)));
  const pixels = Math.floor(unscaled * fit);
  return Math.max(MIN_MULTIPLIER, (pixels - PIXEL_EPSILON) / (fontSize * density));
}

const labelClass = (index: number, reached: number) =>
  cx("text-footnote", index < reached ? "font-semibold text-navy-900" : "text-gray-500");

/**
 * Milestones on one track: a rounded segment per milestone that fills green as it is reached,
 * each label under its segment (the reached ones in navy-900, the next ones in gray-500). A
 * change fills or empties the segments in turn over `motion.stepSlideMs`; the first frame shows
 * where it is, and Reduce Motion jumps there. One progress bar to assistive technology. At large
 * text the labels share one size (`sharedLabelMultiplier`, from a hidden row of their widths).
 */
export function Milestones({ labels, reached, label, valueText, testID }: MilestonesProps) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(reached);
  const { width: windowWidth } = useWindowDimensions();
  const [column, setColumn] = useState(0);
  const [widths, setWidths] = useState<readonly (number | undefined)[]>([]);
  const multiplier = sharedLabelMultiplier(
    column,
    labels.map((_, index) => widths[index]),
    LABEL_FONT_SIZE,
    PixelRatio.get(),
  );
  const measured = (index: number, width: number) =>
    setWidths((current) =>
      current[index] === width
        ? current
        : labels.map((_, at) => (at === index ? width : current[at])),
    );

  useEffect(() => {
    progress.value = reduceMotion ? reached : withTiming(reached, { duration: stepSlideMs });
  }, [progress, reached, reduceMotion]);

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: labels.length, now: reached, text: valueText }}
      className="gap-2"
      testID={testID}
    >
      <View className="flex-row gap-1">
        {labels.map((_, index) => (
          <Segment
            key={index}
            index={index}
            progress={progress}
            testID={testID && `${testID}-segment-${index + 1}`}
          />
        ))}
      </View>
      <View className="flex-row gap-1">
        {labels.map((text, index) => (
          <Text
            key={index}
            // One line that shrinks to its column: a long word ("Trabajando" at font scale 2) is
            // never split, which a second line would allow.
            numberOfLines={1}
            // The shared size first; a label that still overflows (a cap cannot go under 1x)
            // shrinks on its own.
            maxFontSizeMultiplier={multiplier}
            adjustsFontSizeToFit
            minimumFontScale={MIN_LABEL_SCALE}
            onLayout={
              index === 0 ? (event) => setColumn(event.nativeEvent.layout.width) : undefined
            }
            className={cx("flex-1", labelClass(index, reached))}
            testID={testID && `${testID}-label-${index + 1}`}
          >
            {text}
          </Text>
        ))}
      </View>
      {/* Out of sight and of assistive technology: each label's width at no font scaling. */}
      <View
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        style={[styles.measure, { width: windowWidth }]}
      >
        {labels.map((text, index) => (
          <Text
            key={index}
            allowFontScaling={false}
            numberOfLines={1}
            onLayout={(event) => measured(index, event.nativeEvent.layout.width)}
            className={labelClass(index, reached)}
            testID={testID && `${testID}-measure-${index + 1}`}
          >
            {text}
          </Text>
        ))}
      </View>
    </View>
  );
}

function Segment({
  index,
  progress,
  testID,
}: {
  index: number;
  progress: SharedValue<number>;
  testID?: string;
}) {
  // The segment's share of the progress: empty before it, full after it.
  const fill = useAnimatedStyle(() => ({
    transform: [{ scaleX: Math.min(1, Math.max(0, progress.value - index)) }],
  }));

  return (
    <View className="h-1.5 flex-1 overflow-hidden rounded-pill bg-gray-500/20" testID={testID}>
      <Animated.View
        className="h-full w-full rounded-pill bg-green-700"
        style={[{ transformOrigin: "left center" }, fill]}
        testID={testID && `${testID}-fill`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // A column that does not stretch its rows, as wide as the window: each label at its own width.
  measure: { position: "absolute", top: 0, left: 0, opacity: 0, alignItems: "flex-start" },
});
