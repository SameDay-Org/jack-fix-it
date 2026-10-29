import { Pressable, Text, View, type AccessibilityActionEvent } from "react-native";

import { bubbleShadow, continuousCorners } from "@/theme";

import { cx } from "./cx";
import { useFlag } from "./useFlag";

export type ValueStepperProps = {
  /** Visible label; also the accessible name of the control. */
  label: string;
  /** The current value as read and shown: "2 h", "Fri, Oct 30". */
  valueText: string;
  onDecrement: () => void;
  onIncrement: () => void;
  canDecrement?: boolean;
  canIncrement?: boolean;
  /** The decrement and increment buttons' names ("Earlier day", "One more hour"). */
  decrementLabel: string;
  incrementLabel: string;
  /** Validation message under the control, read politely when it appears. */
  error?: string;
  /** Danger ring only, when the message is shown once for a group of steppers. */
  invalid?: boolean;
  testID: string;
};

/**
 * A value read as text ("2 h", "Fri, Oct 30") changed one step at a time, where `Stepper` holds
 * a bounded whole number: − and + pills around the value in a white bubble. Screen
 * readers get one adjustable control (swipe up or down on iOS, the actions menu on Android) named
 * by the label and reading the value; the pills are for touch, 48 dp each.
 */
export function ValueStepper({
  label,
  valueText,
  onDecrement,
  onIncrement,
  canDecrement = true,
  canIncrement = true,
  decrementLabel,
  incrementLabel,
  error,
  invalid = false,
  testID,
}: ValueStepperProps) {
  const onAccessibilityAction = ({ nativeEvent }: AccessibilityActionEvent) => {
    if (nativeEvent.actionName === "decrement" && canDecrement) onDecrement();
    if (nativeEvent.actionName === "increment" && canIncrement) onIncrement();
  };

  return (
    <View>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text: valueText }}
        accessibilityHint={error}
        accessibilityActions={[
          { name: "decrement", label: decrementLabel },
          { name: "increment", label: incrementLabel },
        ]}
        onAccessibilityAction={onAccessibilityAction}
        testID={testID}
      >
        <Text className="mb-2 text-callout font-semibold text-navy-900">{label}</Text>
        <View
          style={[bubbleShadow, continuousCorners]}
          className={cx(
            "min-h-14 flex-row items-center gap-2 rounded-md border-2 bg-white p-1",
            error || invalid ? "border-danger" : "border-transparent",
          )}
        >
          <StepButton
            sign="minus"
            label={decrementLabel}
            onPress={onDecrement}
            disabled={!canDecrement}
            testID={`${testID}-decrement`}
          />
          <Text
            className="flex-1 text-center text-headline text-navy-900"
            testID={`${testID}-value`}
          >
            {valueText}
          </Text>
          <StepButton
            sign="plus"
            label={incrementLabel}
            onPress={onIncrement}
            disabled={!canIncrement}
            testID={`${testID}-increment`}
          />
        </View>
      </View>
      {error ? (
        <Text accessibilityLiveRegion="polite" className="mt-1 text-footnote text-danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

type StepButtonProps = {
  sign: "minus" | "plus";
  label: string;
  onPress: () => void;
  disabled: boolean;
  testID: string;
};

/** A round 48 dp pill with a drawn − or +, so the glyph is the same in every font and scale. */
function StepButton({ sign, label, onPress, disabled, testID }: StepButtonProps) {
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
      hitSlop={4}
      testID={testID}
      className={cx(
        "h-12 w-12 items-center justify-center rounded-pill",
        pressed ? "bg-navy-900/10" : "bg-gray-50",
        disabled && "opacity-40",
      )}
    >
      <View className="h-4 w-4 items-center justify-center">
        <View className="absolute h-0.5 w-4 rounded-pill bg-navy-900" />
        {sign === "plus" ? <View className="absolute h-4 w-0.5 rounded-pill bg-navy-900" /> : null}
      </View>
    </Pressable>
  );
}
