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
  | "maxLength"
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
   * Fixed text at the field's left end that is part of the value but not typed (a calling code
   * such as `+1`). Read before the field by screen readers.
   */
  prefix?: string;
  /**
   * A control at the field's right end (a show/hide toggle). It gets its own cell in the bubble's
   * row, so the text column is whatever width remains: nothing overlaps at any font scale.
   */
  accessory?: ReactNode;
  /** Several lines of text, growing from a three-line box. */
  multiline?: boolean;
  /** Shows "120 / 2000" under the field; needs `maxLength`. */
  counter?: boolean;
  /** The field lost focus (the focus ring is handled here). */
  onBlur?: () => void;
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
  prefix,
  accessory,
  multiline = false,
  counter = false,
  onBlur,
  ref,
  className,
  testID,
  ...textInputProps
}: InputProps) {
  const [focused, focus, blur] = useFlag();
  const hasError = Boolean(error);
  const message = error || hint;
  const ring = hasError || invalid ? RING.error : focused ? RING.focused : RING.rest;
  const count =
    counter && textInputProps.maxLength !== undefined
      ? `${value.length} / ${textInputProps.maxLength}`
      : null;
  const handleBlur = () => {
    blur();
    onBlur?.();
  };

  return (
    <View className={className}>
      <Text className="mb-2 text-callout font-semibold text-navy-900">{label}</Text>
      <View
        testID={testID && `${testID}-bubble`}
        style={[bubbleShadow, continuousCorners]}
        className={cx(
          "min-h-12 flex-row rounded-md border-2 bg-white",
          multiline ? "items-stretch" : "items-center",
          ring,
          disabled && "opacity-50",
        )}
      >
        {prefix ? (
          <Text className="pl-4 text-body text-gray-500" testID={testID && `${testID}-prefix`}>
            {prefix}
          </Text>
        ) : null}
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
          onBlur={handleBlur}
          multiline={multiline}
          textAlignVertical={multiline ? "top" : "center"}
          testID={testID}
          className={cx(
            "flex-1 text-body text-navy-900",
            multiline ? "min-h-28 py-3" : "min-h-12",
            prefix ? "pl-2 pr-4" : "px-4",
          )}
        />
        {accessory ? <View className="pr-1">{accessory}</View> : null}
      </View>
      {message || count ? (
        <View className="mt-1 flex-row gap-3">
          <Text
            accessibilityLiveRegion={hasError ? "polite" : "none"}
            className={cx("flex-1 text-footnote", hasError ? "text-danger" : "text-gray-500")}
          >
            {message}
          </Text>
          {count ? (
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no"
              className="text-footnote text-gray-500"
              testID={testID && `${testID}-counter`}
            >
              {count}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
