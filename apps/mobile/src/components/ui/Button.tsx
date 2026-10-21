import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { cx } from "./cx";

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

// Primary is navy on orange (5.39:1): white on orange is 3.06:1 and fails WCAG AA.
const VARIANT: Record<ButtonVariant, { container: string; text: string }> = {
  primary: { container: "bg-orange active:bg-orange/90", text: "text-navy" },
  secondary: { container: "border-2 border-navy active:bg-navy/10", text: "text-navy" },
  ghost: { container: "active:bg-navy/10", text: "text-navy" },
};

// px values so the touch target (48 dp minimum) does not depend on the rem base.
const SIZE: Record<ButtonSize, { container: string; text: string }> = {
  md: { container: "min-h-[48px] min-w-[48px] px-5", text: "text-base" },
  lg: { container: "min-h-[56px] min-w-[56px] px-6", text: "text-lg" },
};

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
  const inactive = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={loading ? `${label}, ${t("common.loading")}` : label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      testID={testID}
      className={cx(
        "flex-row items-center justify-center rounded-2xl",
        VARIANT[variant].container,
        SIZE[size].container,
        disabled && "opacity-50",
        className,
      )}
    >
      {/* The label stays mounted, invisible, while loading so the width does not jump. */}
      <Text
        className={cx(
          "text-center font-semibold",
          VARIANT[variant].text,
          SIZE[size].text,
          loading && "opacity-0",
        )}
      >
        {label}
      </Text>
      {loading ? (
        <View className="pointer-events-none absolute inset-0 items-center justify-center">
          <ActivityIndicator className={VARIANT[variant].text} />
        </View>
      ) : null}
    </Pressable>
  );
}
