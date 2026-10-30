import { Text, View } from "react-native";
import Animated from "react-native-reanimated";

import { cx } from "./cx";
import { useSkeletonPulse } from "./Skeleton";

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger" | "brand";

export type StatusBadgeProps = {
  /** Already translated by the caller; the badge never maps statuses itself. */
  label: string;
  tone: StatusTone;
  className?: string;
  testID?: string;
};

// Pills, token classes only; src/theme/tokens.test.ts checks every pair, tints composited on white
// and gray-50. Quiet tones are tints; semantic tones are solid pills like the deck shapes (04b, 04c)
// because no visible tint carries their text at AA: green-700 on a green-500/10 tint is 4.49:1 and
// danger on a danger/10 tint is 4.12:1. `success` and `warning` are never text (brief rule).
export const TONE: Record<StatusTone, { container: string; text: string }> = {
  neutral: { container: "bg-gray-500/10", text: "text-gray-500" },
  info: { container: "bg-navy-900/10", text: "text-navy-900" },
  success: { container: "bg-green-700", text: "text-white" },
  warning: { container: "bg-warning", text: "text-navy-900" },
  danger: { container: "bg-danger", text: "text-white" },
  brand: { container: "bg-green-500", text: "text-navy-900" },
};

// The pill and its label; StatusBadgeSkeleton below shares both so a loading row never jumps. The
// end padding is 2 dp short: the label's trailing thin space (`withRoom`) makes up the rest.
const SHAPE = "self-start rounded-pill py-1 pl-3 pr-2.5";
const LABEL = "text-caption";
/**
 * Android lays a label out again when it draws it, and that pass can need a sub-pixel more than the
 * width the label was measured at: "Request Received" broke after its first word, under the pill's
 * height. A trailing thin space widens the measured box by about 2 dp, and a line's end spaces
 * take no width when Android breaks lines, so the label always draws on the line it measured on.
 */
const withRoom = (label: string) => `${label}\u2009`;

export function StatusBadge({ label, tone, className, testID }: StatusBadgeProps) {
  return (
    <View testID={testID} className={cx(SHAPE, TONE[tone].container, className)}>
      <Text accessibilityRole="text" className={cx(LABEL, TONE[tone].text)}>
        {withRoom(label)}
      </Text>
    </View>
  );
}

export type StatusBadgeSkeletonProps = {
  /** The label the badge will carry, invisible: the pill is exactly its size at any font scale. */
  label: string;
  testID?: string;
};

/**
 * A pill-shaped placeholder of the badge's exact size. Hidden from assistive technology; the
 * caller labels the loading group once.
 */
export function StatusBadgeSkeleton({ label, testID }: StatusBadgeSkeletonProps) {
  const pulse = useSkeletonPulse();

  return (
    <Animated.View style={pulse} testID={testID}>
      <View className={cx(SHAPE, "bg-gray-500/15")}>
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className={cx(LABEL, "opacity-0")}
        >
          {withRoom(label)}
        </Text>
      </View>
    </Animated.View>
  );
}
