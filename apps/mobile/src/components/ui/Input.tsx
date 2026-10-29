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
  | "onBlur"
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
  /** A tall field for a few sentences: the text starts at the top and wraps. */
  multiline?: boolean;
  /** A short note at the end of the message line, such as how many characters are left. */
  counter?: string;
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
  multiline = false,
  counter,
  disabled = false,
  prefix,
  accessory,
  ref,
  className,
  testID,
  onBlur,
  ...textInputProps
}: InputProps) {
  const [focused, focus, blurred] = useFlag();
  const blur: NonNullable<InputProps["onBlur"]> = (event) => {
    blurred();
    onBlur?.(event);
  };
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
          "min-h-12 flex-row rounded-md border-2 bg-white",
          multiline ? "items-start" : "items-center",
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
          onBlur={blur}
          multiline={multiline}
          textAlignVertical={multiline ? "top" : undefined}
          testID={testID}
          className={cx(
            "min-h-12 flex-1 text-body text-navy-900",
            multiline && "min-h-32 py-3",
            prefix ? "pl-2 pr-4" : "px-4",
          )}
        />
        {accessory ? <View className="pr-1">{accessory}</View> : null}
      </View>
      {message || counter ? (
        <View className="mt-1 flex-row gap-3">
          <Text
            accessibilityLiveRegion={hasError ? "polite" : "none"}
            className={cx("flex-1 text-footnote", hasError ? "text-danger" : "text-gray-500")}
          >
            {message}
          </Text>
          {counter ? (
            <Text
              accessibilityLiveRegion="polite"
              className="text-footnote text-gray-500"
              testID={testID && `${testID}-counter`}
            >
              {counter}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
