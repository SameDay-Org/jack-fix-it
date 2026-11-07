import type { ComponentRef, Ref } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { ControlIcon, type ControlGlyphName } from "@/components/icons";
import { continuousCorners, tokens, type ColorToken } from "@/theme";

import { cx } from "./cx";
import { useFlag } from "./useFlag";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "hero";
export type ButtonSize = "md" | "lg";

export type ButtonProps = {
  /** Visible text; also the accessible name unless `accessibilityLabel` gives a fuller one. */
  label: string;
  /** A fuller name for assistive technology, e.g. "Remove Photo 2" where many rows say "Remove". */
  accessibilityLabel?: string;
  /** What the press does or where it lands, when the label alone does not say it. */
  accessibilityHint?: string;
  /**
   * Shows this glyph in place of the visible label: a round icon button, for a row too tight for
   * the word. The label stays its accessible name.
   */
  glyph?: ControlGlyphName;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Ignores presses and dims the button. */
  disabled?: boolean;
  /** Shows a spinner and ignores presses; the width does not change. */
  loading?: boolean;
  /** Layout-only classes (margins, width). */
  className?: string;
  /** The pressable host, to move screen-reader focus onto the button. */
  ref?: Ref<ComponentRef<typeof View>>;
  testID?: string;
};

type StateClasses = { rest: string; pressed: string };

type VariantClasses = {
  /** Always on the container. */
  base: string;
  fill: StateClasses;
  label: StateClasses;
  /** The surfaces the variant sits on; the contrast test checks the label over each. Light by default. */
  on?: readonly ColorToken[];
};

// Pairs from the contrast table in docs/design/README.md: navy-900 on green-500 at rest, white on
// green-700 while pressed. Secondary and ghost press into a navy-900 tint and keep navy-900 text.
// Hero is the ghost for navy surfaces: white text on a translucent white pill that gets a little
// more opaque while pressed, both well above AA over navy-900.
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
  hero: {
    base: "",
    fill: { rest: "bg-white/15", pressed: "bg-white/25" },
    label: { rest: "text-white", pressed: "text-white" },
    on: ["navy-900"],
  },
};

// Touch targets of 48 dp (md) and 56 dp (lg) on the spacing scale; both sizes use the headline style.
const SIZE: Record<ButtonSize, string> = {
  md: "min-h-12 min-w-12 px-5",
  lg: "min-h-14 min-w-14 px-6",
};
// An icon button is a circle of the same touch target.
const ROUND: Record<ButtonSize, string> = { md: "h-12 w-12", lg: "h-14 w-14" };
const GLYPH_SIZE = 24;

const forState = (classes: StateClasses, pressed: boolean) =>
  pressed ? classes.pressed : classes.rest;

export function Button({
  label,
  accessibilityLabel,
  accessibilityHint,
  glyph,
  onPress,
  variant = "primary",
  size = "md",
  disabled = false,
  loading = false,
  className,
  ref,
  testID,
}: ButtonProps) {
  const { t } = useTranslation();
  const [pressed, pressIn, pressOut] = useFlag();
  const inactive = disabled || loading;
  const classes = VARIANT[variant];

  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={
        loading
          ? `${accessibilityLabel ?? label}, ${t("common.loading")}`
          : (accessibilityLabel ?? label)
      }
      accessibilityHint={accessibilityHint}
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
        glyph ? ROUND[size] : SIZE[size],
        disabled && "opacity-50",
        className,
      )}
    >
      {/* The label stays mounted, invisible, while loading so the width does not jump. A button label
          is one line by contract: without `numberOfLines`, Android can wrap a label that measures as
          one line by a fraction of a pixel and hide its second half. */}
      {glyph ? (
        <View className={cx(loading && "opacity-0")}>
          <ControlIcon
            name={glyph}
            size={GLYPH_SIZE}
            // The label's colour in the same state: white on hero, and on primary while pressed.
            color={
              variant === "hero" || (variant === "primary" && pressed)
                ? tokens.colors.white
                : tokens.colors["navy-900"]
            }
          />
        </View>
      ) : (
        <Text
          numberOfLines={1}
          className={cx(
            "text-center text-headline",
            forState(classes.label, pressed),
            loading && "opacity-0",
          )}
        >
          {label}
        </Text>
      )}
      {loading ? (
        <View className="pointer-events-none absolute inset-0 items-center justify-center">
          <ActivityIndicator className={classes.label.rest} />
        </View>
      ) : null}
    </Pressable>
  );
}
