import type { ComponentRef, ReactNode, Ref } from "react";
import { Text, TextInput, View, type TextInputProps } from "react-native";

import { bubbleShadow, continuousCorners } from "@/theme";

import { cx } from "./cx";
import { useFlag } from "./useFlag";

type PassthroughProps = Pick<
  TextInputProps,
  | "secureTextEntry"
  | "keyboardType"
  | "inputMode"
  | "autoComplete"
  | "textContentType"
  | "autoCapitalize"
  | "autoCorrect"
  | "autoFocus"
  | "importantForAutofill"
  | "returnKeyType"
  | "submitBehavior"
  | "onSubmitEditing"
>;

/** The native field behind an `Input`, for focus management between fields. */
export type InputHandle = ComponentRef<typeof TextInput>;

export type InputProps = PassthroughProps & {
  /** Visible label; also the accessible name of the field. */
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  /** Helper text under the field. `error` replaces it while set. */
  hint?: string;
  /** Validation message: danger ring, text under the field and the screen-reader hint. */
  error?: string;
  /** Danger ring only, when the message is shown elsewhere (a form-level error that names this field). */
  invalid?: boolean;
  disabled?: boolean;
  /**
   * A control at the field's right end (a show/hide toggle). It gets its own cell in the bubble's
   * row, so the text column is whatever width remains: nothing overlaps at any font scale.
   */
  accessory?: ReactNode;
  /** The native field, so a previous field's return key can move focus here. */
  ref?: Ref<InputHandle>;
  /** Layout-only classes for the wrapper (margins, width). */
  className?: string;
  testID?: string;
};

// The bubble is a row: the field fills it, the accessory sits beside it. White, lifted by the
// shadow, with no hairline at rest; the 2 px ring is always present so the size never changes:
// transparent at rest, green-700 focused, danger on error.
const RING = { rest: "border-transparent", focused: "border-green-700", error: "border-danger" };

export function Input({
  label,
  value,
  onChangeText,
  hint,
  error,
  invalid = false,
  disabled = false,
  accessory,
  ref,
  className,
  testID,
  ...textInputProps
}: InputProps) {
  const [focused, focus, blur] = useFlag();
  const hasError = Boolean(error);
  const message = error || hint;
  const ring = hasError || invalid ? RING.error : focused ? RING.focused : RING.rest;

  return (
    <View className={className}>
      <Text className="mb-2 text-callout font-semibold text-navy-900">{label}</Text>
      <View
        testID={testID && `${testID}-bubble`}
        style={[bubbleShadow, continuousCorners]}
        className={cx(
          "min-h-12 flex-row items-center rounded-md border-2 bg-white",
          ring,
          disabled && "opacity-50",
        )}
      >
        <TextInput
          {...textInputProps}
          ref={ref}
          accessibilityLabel={label}
          accessibilityHint={message}
          accessibilityState={{ disabled }}
          editable={!disabled}
          value={value}
          onChangeText={onChangeText}
          onFocus={focus}
          onBlur={blur}
          testID={testID}
          className="min-h-12 flex-1 px-4 text-body text-navy-900"
        />
        {accessory ? <View className="pr-1">{accessory}</View> : null}
      </View>
      {message ? (
        <Text
          accessibilityLiveRegion={hasError ? "polite" : "none"}
          className={cx("mt-1 text-footnote", hasError ? "text-danger" : "text-gray-500")}
        >
          {message}
        </Text>
      ) : null}
    </View>
  );
}
