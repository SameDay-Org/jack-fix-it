import { Text, View } from "react-native";

import { cx } from "./cx";

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

export function StatusBadge({ label, tone, className, testID }: StatusBadgeProps) {
  return (
    <View
      testID={testID}
      className={cx("self-start rounded-pill px-3 py-1", TONE[tone].container, className)}
    >
      <Text accessibilityRole="text" className={cx("text-caption", TONE[tone].text)}>
        {label}
      </Text>
    </View>
  );
}
