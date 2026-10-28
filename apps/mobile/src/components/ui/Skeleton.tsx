import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { View, type DimensionValue } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import type { Radius } from "@/theme";

import { cx } from "./cx";

export type SkeletonProps = {
  width?: DimensionValue;
  height?: number;
  /** Corner radius token; text lines read as pills at `sm`. */
  radius?: Radius;
  /** Round placeholder: `height` is the diameter; `width` and `radius` are ignored. */
  circle?: boolean;
  /** Extra classes for the placeholder (margins). */
  className?: string;
  testID?: string;
};

const RADIUS: Record<Radius, string> = {
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
  pill: "rounded-pill",
};

const PULSE_DURATION_MS = 900;
const PULSE_MIN_OPACITY = 0.4;

/** The placeholder pulse as an animated style; static under Reduce Motion. Every skeleton shape uses it. */
export function useSkeletonPulse() {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (reducedMotion) return; // static placeholder
    opacity.value = withRepeat(
      withTiming(PULSE_MIN_OPACITY, {
        duration: PULSE_DURATION_MS,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(opacity);
      opacity.value = 1;
    };
  }, [opacity, reducedMotion]);

  return useAnimatedStyle(() => ({ opacity: opacity.value }));
}

export function Skeleton({
  width = "100%",
  height = 16,
  radius = "sm",
  circle = false,
  className,
  testID,
}: SkeletonProps) {
  const { t } = useTranslation();
  const animatedStyle = useSkeletonPulse();
  const shape = circle ? { width: height, height } : { width, height };

  return (
    <Animated.View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("common.loading")}
      testID={testID}
      style={animatedStyle}
    >
      <View
        className={cx("bg-gray-500/15", circle ? RADIUS.pill : RADIUS[radius], className)}
        style={shape}
      />
    </Animated.View>
  );
}
