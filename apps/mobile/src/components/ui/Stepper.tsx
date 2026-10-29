import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type AccessibilityActionEvent } from "react-native";

import { ControlIcon } from "@/components/icons";
import { bubbleShadow, continuousCorners, pressedTransform, tokens } from "@/theme";

import { cx } from "./cx";
import { useFlag } from "./useFlag";

export type StepperProps = {
  /** The question it answers: its accessible name. */
  label: string;
  /** Null until the first press: no value is chosen for the customer. */
  value: number | null;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** Danger ring, when the message under it says why. */
  invalid?: boolean;
  testID?: string;
};

const ACTIONS = [{ name: "increment" }, { name: "decrement" }] as const;

/**
 * A whole number between `min` and `max`, one step at a time: a white pill with round minus and
 * plus buttons around the value. It starts empty (a blank slot, the minus faded); the first plus
 * gives `min`. Screen readers get one adjustable control (swipe up or down) with the value, not
 * three buttons.
 */
export function Stepper({
  label,
  value,
  min,
  max,
  onChange,
  invalid = false,
  testID,
}: StepperProps) {
  const { t } = useTranslation();
  const canDecrease = value !== null && value > min;
  const canIncrease = value === null || value < max;
  const increase = () => onChange(value === null ? min : Math.min(max, value + 1));
  const decrease = () => {
    if (value !== null) onChange(Math.max(min, value - 1));
  };

  const onAccessibilityAction = ({ nativeEvent }: AccessibilityActionEvent) => {
    if (nativeEvent.actionName === "increment" && canIncrease) increase();
    if (nativeEvent.actionName === "decrement" && canDecrease) decrease();
  };

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={
        value === null
          ? { text: t("common.notSet") }
          : { min, max, now: value, text: String(value) }
      }
      accessibilityActions={ACTIONS}
      onAccessibilityAction={onAccessibilityAction}
      testID={testID}
      style={[bubbleShadow, continuousCorners]}
      className={cx(
        "flex-row items-center self-start rounded-pill border-2 bg-white p-1",
        invalid ? "border-danger" : "border-transparent",
      )}
    >
      <StepButton
        glyph="minus"
        disabled={!canDecrease}
        onPress={decrease}
        testID={testID && `${testID}-decrease`}
      />
      <Text
        className="min-w-16 px-2 text-center text-title-2 text-navy-900"
        testID={testID && `${testID}-value`}
      >
        {value ?? ""}
      </Text>
      <StepButton
        glyph="plus"
        disabled={!canIncrease}
        onPress={increase}
        testID={testID && `${testID}-increase`}
      />
    </View>
  );
}

type StepButtonProps = {
  glyph: "plus" | "minus";
  disabled: boolean;
  onPress: () => void;
  testID?: string;
};

// Touch only: the stepper itself is the one adjustable control screen readers reach (its
// increment and decrement actions do what these do), so the buttons stay out of the tree.
function StepButton({ glyph, disabled, onPress, testID }: StepButtonProps) {
  const [pressed, pressIn, pressOut] = useFlag();

  return (
    <Pressable
      accessible={false}
      focusable={false}
      importantForAccessibility="no"
      accessibilityElementsHidden
      disabled={disabled}
      onPress={onPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
      testID={testID}
      style={pressed ? pressedTransform : undefined}
      className={cx(
        "h-12 w-12 items-center justify-center rounded-pill bg-gray-50",
        disabled && "opacity-40",
      )}
    >
      <ControlIcon name={glyph} color={tokens.colors["navy-900"]} />
    </Pressable>
  );
}
