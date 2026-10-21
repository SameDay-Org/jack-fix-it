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

// Tinted pills, token colors only. Brand uses navy text: orange on white is 3.06:1 (fails AA).
const TONE: Record<StatusTone, { container: string; text: string }> = {
  neutral: { container: "bg-gray/10", text: "text-gray" },
  info: { container: "bg-navy/10", text: "text-navy" },
  success: { container: "bg-success/10", text: "text-success" },
  warning: { container: "bg-warning/10", text: "text-warning" },
  danger: { container: "bg-danger/10", text: "text-danger" },
  brand: { container: "bg-orange/15", text: "text-navy" },
};

export function StatusBadge({ label, tone, className, testID }: StatusBadgeProps) {
  return (
    <View
      testID={testID}
      className={cx("self-start rounded-full px-2.5 py-1", TONE[tone].container, className)}
    >
      <Text accessibilityRole="text" className={cx("text-xs font-semibold", TONE[tone].text)}>
        {label}
      </Text>
    </View>
  );
}
