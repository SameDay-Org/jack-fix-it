import { Pressable, Text, useWindowDimensions, View } from "react-native";
import Animated from "react-native-reanimated";

import { bubbleShadow, continuousCorners, pressedTransform } from "@/theme";

import { cx } from "./cx";
import { useSkeletonPulse } from "./Skeleton";
import { useFlag } from "./useFlag";

export type ChipProps = {
  /** Visible text and accessible name; one line, ending in an ellipsis if it is wider than the row. */
  label: string;
  onPress: () => void;
  /**
   * Makes the chip one of a multi-select set: a checkbox to assistive technology, filled navy while
   * selected. Left out, the chip is a plain button.
   */
  selected?: boolean;
  /** Read after the label by screen readers: what the choice covers. */
  hint?: string;
  /** Ignores presses and dims the chip. */
  disabled?: boolean;
  /** Layout-only classes (margins). */
  className?: string;
  testID?: string;
};

// A pill-shaped choice on a light page: a white bubble with the shared shadow, the headline style
// and a 48 dp minimum height. ChipSkeleton below shares the shape so a loading row never jumps.
const SHAPE = "min-h-12 max-w-full justify-center rounded-pill px-4 py-3";
const SURFACE_STYLE = [bubbleShadow, continuousCorners];

export function Chip({
  label,
  onPress,
  selected,
  hint,
  disabled = false,
  className,
  testID,
}: ChipProps) {
  const [pressed, pressIn, pressOut] = useFlag();
  const toggle = selected !== undefined;

  return (
    <Pressable
      accessibilityRole={toggle ? "checkbox" : "button"}
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={toggle ? { disabled, checked: selected } : { disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
      testID={testID}
      style={pressed ? [...SURFACE_STYLE, pressedTransform] : SURFACE_STYLE}
      className={cx(
        SHAPE,
        selected ? "bg-navy-900" : "bg-white",
        disabled && "opacity-50",
        className,
      )}
    >
      {/* One line by contract, as the kit's Button: without `numberOfLines`, Android can wrap a label
          that measures as one line by a fraction of a pixel and hide its second half (seen with
          "Jardinería y paisajismo" at 320 dp). The chips themselves wrap onto new rows. */}
      <Text
        numberOfLines={1}
        className={cx("text-center text-headline", selected ? "text-white" : "text-navy-900")}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export type ChipSkeletonProps = {
  /**
   * Width of the placeholder label at font scale 1, in dp. It grows with the system font scale, and
   * the height follows the label's type, so placeholders break into rows as the chips will.
   */
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
  const { fontScale } = useWindowDimensions();

  return (
    <Animated.View style={pulse} testID={testID}>
      <View
        style={continuousCorners}
        className={cx(SHAPE, "bg-gray-500/15")}
        testID={testID && `${testID}-shape`}
      >
        <Text className="text-headline text-transparent" style={{ width: labelWidth * fontScale }}>
          {" "}
        </Text>
      </View>
    </Animated.View>
  );
}
