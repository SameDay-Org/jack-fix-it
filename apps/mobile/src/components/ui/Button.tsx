import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { continuousCorners } from "@/theme";

import { cx } from "./cx";
import { useFlag } from "./useFlag";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "md" | "lg";

export type ButtonProps = {
  /** Visible text; also the accessible name. */
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Ignores presses and dims the button. */
  disabled?: boolean;
  /** Shows a spinner and ignores presses; the width does not change. */
  loading?: boolean;
  /** Layout-only classes (margins, width). */
  className?: string;
  testID?: string;
};

type StateClasses = { rest: string; pressed: string };

type VariantClasses = {
  /** Always on the container. */
  base: string;
  fill: StateClasses;
  label: StateClasses;
};

// Pairs from the contrast table in docs/design/README.md: navy-900 on green-500 at rest, white on
// green-700 while pressed. Secondary and ghost press into a navy-900 tint and keep navy-900 text.
export const VARIANT: Record<ButtonVariant, VariantClasses> = {
  primary: {
    base: "",
    fill: { rest: "bg-green-500", pressed: "bg-green-700" },
    label: { rest: "text-navy-900", pressed: "text-white" },
  },
  secondary: {
    base: "border-2 border-navy-900",
    fill: { rest: "", pressed: "bg-navy-900/10" },
    label: { rest: "text-navy-900", pressed: "text-navy-900" },
  },
  ghost: {
    base: "",
    fill: { rest: "", pressed: "bg-navy-900/10" },
    label: { rest: "text-navy-900", pressed: "text-navy-900" },
  },
};

// Touch targets of 48 dp (md) and 56 dp (lg) on the spacing scale; both sizes use the headline style.
const SIZE: Record<ButtonSize, string> = {
  md: "min-h-12 min-w-12 px-5",
  lg: "min-h-14 min-w-14 px-6",
};

const forState = (classes: StateClasses, pressed: boolean) =>
  pressed ? classes.pressed : classes.rest;

export function Button({
  label,
  onPress,
  variant = "primary",
  size = "md",
  disabled = false,
  loading = false,
  className,
  testID,
}: ButtonProps) {
  const { t } = useTranslation();
  const [pressed, pressIn, pressOut] = useFlag();
  const inactive = disabled || loading;
  const classes = VARIANT[variant];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={loading ? `${label}, ${t("common.loading")}` : label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
      testID={testID}
      style={continuousCorners}
      className={cx(
        "flex-row items-center justify-center rounded-pill",
        classes.base,
        forState(classes.fill, pressed),
        SIZE[size],
        disabled && "opacity-50",
        className,
      )}
    >
      {/* The label stays mounted, invisible, while loading so the width does not jump. */}
      <Text
        className={cx(
          "text-center text-headline",
          forState(classes.label, pressed),
          loading && "opacity-0",
        )}
      >
        {label}
      </Text>
      {loading ? (
        <View className="pointer-events-none absolute inset-0 items-center justify-center">
          <ActivityIndicator className={classes.label.rest} />
        </View>
      ) : null}
    </Pressable>
  );
}
