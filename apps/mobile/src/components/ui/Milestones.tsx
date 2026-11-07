import { useEffect } from "react";
import { Text, View } from "react-native";
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

/**
 * Milestones on one track: a rounded segment per milestone that fills green as it is reached,
 * each label under its segment (the reached ones in navy-900, the next ones in gray-500). A
 * change fills or empties the segments in turn over `motion.stepSlideMs`; the first frame shows
 * where it is, and Reduce Motion jumps there. One progress bar to assistive technology.
 */
export function Milestones({ labels, reached, label, valueText, testID }: MilestonesProps) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(reached);

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
            adjustsFontSizeToFit
            minimumFontScale={MIN_LABEL_SCALE}
            className={cx(
              "flex-1 text-footnote",
              index < reached ? "font-semibold text-navy-900" : "text-gray-500",
            )}
            testID={testID && `${testID}-label-${index + 1}`}
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
