import { useEffect, useId } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { bubbleShadow, tokens, withOpacity } from "@/theme";

export type FlowProgressProps = {
  /** Steps completed so far, from 0: the bar fills `completed / total` of its width. */
  completed: number;
  total: number;
  /** "Step 2 of 5", in the app's language: the bar's spoken name. */
  label: string;
  testID?: string;
};

/** The bar's thickness; also the fill's rounded ends and the dot it shows before any step is done. */
const THICKNESS = 10;
/** A little overshoot as a step lands, then still. */
const FILL_SPRING = { damping: 18, stiffness: 150 };
/** The track's tint, and the shade along its top edge that makes it a groove. */
const TRACK_TINT = 0.08;
const GROOVE_SHADE = 0.14;
const GROOVE_DEPTH = 0.7;
/** The light along the fill's top edge: a rounded face catching the light. */
const FILL_GLINT = 0.55;
const FILL_GLINT_DEPTH = 0.55;
const FULL = 100;

/**
 * Where a multi-step flow is, as one quiet bar: a groove across the width, and a green fill that
 * grows along it on a spring as each step lands, lit along its top and lifted by the bubble shadow,
 * so it reads as a thing that sits in the groove rather than a flat tint. Before the first step
 * is done it shows a dot at the start. Under Reduce Motion the fill moves without animating. One
 * progress bar to assistive technology, named by `label`.
 */
export function FlowProgress({ completed, total, label, testID }: FlowProgressProps) {
  const id = useId();
  const reduceMotion = useReducedMotion();
  const done = Math.min(Math.max(completed, 0), Math.max(total, 0));
  const fraction = total > 0 ? done / total : 0;
  const progress = useSharedValue(fraction);

  useEffect(() => {
    progress.value = reduceMotion ? fraction : withSpring(fraction, FILL_SPRING);
  }, [fraction, progress, reduceMotion]);

  const fillStyle = useAnimatedStyle(() => ({
    width: `${Math.min(FULL, Math.max(0, progress.value * FULL))}%`,
  }));

  const navy = tokens.colors["navy-900"];
  const grooveId = `${id}-groove`;
  const faceId = `${id}-face`;
  const glintId = `${id}-glint`;

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: total, now: done }}
      style={styles.bar}
      testID={testID}
    >
      <View style={[styles.track, { backgroundColor: withOpacity("navy-900", TRACK_TINT) }]}>
        <Svg pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Defs>
            <LinearGradient id={grooveId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={navy} stopOpacity={GROOVE_SHADE} />
              <Stop offset={GROOVE_DEPTH} stopColor={navy} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" rx={THICKNESS / 2} fill={`url(#${grooveId})`} />
        </Svg>
      </View>
      <Animated.View
        style={[styles.fill, bubbleShadow, fillStyle]}
        testID={testID && `${testID}-fill`}
      >
        <Svg pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Defs>
            <LinearGradient id={faceId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={tokens.colors["green-500"]} />
              <Stop offset="1" stopColor={tokens.colors["green-700"]} />
            </LinearGradient>
            <LinearGradient id={glintId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={tokens.colors.white} stopOpacity={FILL_GLINT} />
              <Stop offset={FILL_GLINT_DEPTH} stopColor={tokens.colors.white} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" rx={THICKNESS / 2} fill={`url(#${faceId})`} />
          <Rect width="100%" height="100%" rx={THICKNESS / 2} fill={`url(#${glintId})`} />
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { height: THICKNESS },
  track: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: THICKNESS / 2,
    overflow: "hidden",
  },
  fill: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    minWidth: THICKNESS,
    borderRadius: THICKNESS / 2,
    backgroundColor: tokens.colors["green-700"],
    overflow: "hidden",
  },
});
