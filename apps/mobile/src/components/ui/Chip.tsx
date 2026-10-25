import { Pressable, Text, View } from "react-native";
import Animated from "react-native-reanimated";

import { bubbleShadow, continuousCorners, pressedTransform } from "@/theme";

import { cx } from "./cx";
import { useSkeletonPulse } from "./Skeleton";
import { useFlag } from "./useFlag";

export type ChipProps = {
  /** Visible text and accessible name. A long label wraps inside the pill instead of clipping. */
  label: string;
  onPress: () => void;
  /** Ignores presses and dims the chip. */
  disabled?: boolean;
  /** Layout-only classes (margins). */
  className?: string;
  testID?: string;
};

// A pill-shaped choice on a light page: a white bubble with the shared shadow, the headline style
// and a 48 dp minimum height. ChipSkeleton below shares the shape so a loading row never jumps.
const SHAPE = "min-h-12 max-w-full justify-center rounded-pill px-5 py-3";
const SURFACE_STYLE = [bubbleShadow, continuousCorners];

export function Chip({ label, onPress, disabled = false, className, testID }: ChipProps) {
  const [pressed, pressIn, pressOut] = useFlag();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
      testID={testID}
      style={pressed ? [...SURFACE_STYLE, pressedTransform] : SURFACE_STYLE}
      className={cx(SHAPE, "bg-white", disabled && "opacity-50", className)}
    >
      <Text className="text-center text-headline text-navy-900">{label}</Text>
    </Pressable>
  );
}

export type ChipSkeletonProps = {
  /** Width of the placeholder label, in dp; the height follows the label's type at any font scale. */
  labelWidth: number;
  testID?: string;
};

/**
 * A chip-shaped placeholder: the same padding and an invisible label line of the chip's type, so
 * it is exactly as tall as the chip it stands for, at any font scale. Hidden from assistive
 * technology; the caller labels the loading group once.
 */
export function ChipSkeleton({ labelWidth, testID }: ChipSkeletonProps) {
  const pulse = useSkeletonPulse();

  return (
    <Animated.View style={pulse} testID={testID}>
      <View
        style={continuousCorners}
        className={cx(SHAPE, "bg-gray-500/15")}
        testID={testID && `${testID}-shape`}
      >
        <Text className="text-headline text-transparent" style={{ width: labelWidth }}>
          {" "}
        </Text>
      </View>
    </Animated.View>
  );
}
