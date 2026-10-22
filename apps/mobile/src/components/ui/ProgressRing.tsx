import { useEffect } from "react";
import { View, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { tokens, withOpacity } from "@/theme";

export type ProgressRingProps = {
  /** From 0 to 1; anything outside is clamped. */
  progress: number;
  /** The accessible name, e.g. "Uploading photo 2". The percentage is its value. */
  accessibilityLabel: string;
  /** Diameter in dp, on the 4-pt grid. */
  size?: number;
  testID?: string;
};

// h-10; the stroke is a tenth of the diameter (4 dp here), so the ring keeps its weight at any size.
const DEFAULT_SIZE = 40;
const STROKE_FRACTION = 0.1;
// The ring sits over a photo under a navy scrim: a white arc on a faint white track.
const ARC = tokens.colors.white;
const TRACK_OPACITY = 0.3;
const TRACK = withOpacity("white", TRACK_OPACITY);
const HALF_TURN = 180;

/**
 * A circular progress indicator, drawn without SVG: each half of the ring is a half-arc (a circle
 * with only two adjacent borders colored covers exactly 180°) rotated inside a clip of its own
 * half. The right half fills first, then the left. Changes animate on the UI thread over
 * `motion.transitionMs`; under Reduce Motion the ring jumps to the new value. Its size never
 * changes, so progress never moves the layout around it.
 */
export function ProgressRing({
  progress,
  accessibilityLabel,
  size = DEFAULT_SIZE,
  testID,
}: ProgressRingProps) {
  const reduceMotion = useReducedMotion();
  const clamped = Math.min(1, Math.max(0, progress));
  const shown = useSharedValue(clamped);

  useEffect(() => {
    shown.value = reduceMotion
      ? clamped
      : withTiming(clamped, { duration: tokens.motion.transitionMs });
  }, [clamped, reduceMotion, shown]);

  // Rotated 45°, a half-arc covers the right half; -135° hides it in the left half, where the
  // right clip cuts it away. The left half-arc starts hidden on the right and turns into place.
  const rightArc = useAnimatedStyle(() => ({
    transform: [{ rotate: `${45 - HALF_TURN + Math.min(shown.value, 0.5) * 360}deg` }],
  }));
  const leftArc = useAnimatedStyle(() => ({
    transform: [{ rotate: `${45 + Math.max(shown.value - 0.5, 0) * 360}deg` }],
  }));

  const half = size / 2;
  const stroke = Math.max(1, Math.round(size * STROKE_FRACTION));
  const circle: ViewStyle = {
    position: "absolute",
    top: 0,
    width: size,
    height: size,
    borderRadius: half,
    borderWidth: stroke,
  };
  const arc: ViewStyle = {
    ...circle,
    borderColor: "transparent",
    borderTopColor: ARC,
    borderRightColor: ARC,
  };
  const clip: ViewStyle = { position: "absolute", top: 0, width: half, height: size, overflow: "hidden" };

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      testID={testID}
      style={{ width: size, height: size }}
    >
      <View style={[circle, { left: 0, borderColor: TRACK }]} />
      <View style={[clip, { left: half }]}>
        <Animated.View style={[arc, { left: -half }, rightArc]} />
      </View>
      <View style={[clip, { left: 0 }]}>
        <Animated.View style={[arc, { left: 0 }, leftArc]} />
      </View>
    </View>
  );
}
