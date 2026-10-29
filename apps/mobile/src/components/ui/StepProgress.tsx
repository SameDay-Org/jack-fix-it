import { Text, View } from "react-native";

import { cx } from "./cx";

export type StepProgressProps = {
  /** The step on screen, from 1. */
  current: number;
  total: number;
  /** "Step 2 of 5", in the app's language: shown, and the progress bar's spoken name. */
  label: string;
  testID?: string;
};

/**
 * Where a multi-step flow is: the label over one rounded segment per step, filled green up to the
 * current one. One progress bar to assistive technology.
 */
export function StepProgress({ current, total, label, testID }: StepProgressProps) {
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: total, now: current }}
      className="gap-2"
      testID={testID}
    >
      <Text className="text-footnote font-semibold text-gray-500">{label}</Text>
      <View className="flex-row gap-1">
        {Array.from({ length: total }, (_, index) => (
          <View
            key={index}
            className={cx(
              "h-1.5 flex-1 rounded-pill",
              index < current ? "bg-green-700" : "bg-gray-500/20",
            )}
            testID={testID && `${testID}-segment-${index + 1}`}
          />
        ))}
      </View>
    </View>
  );
}
