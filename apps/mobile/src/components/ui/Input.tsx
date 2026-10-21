import { Text, TextInput, View, type TextInputProps } from "react-native";

import { cx } from "./cx";

type PassthroughProps = Pick<
  TextInputProps,
  "secureTextEntry" | "keyboardType" | "autoComplete" | "textContentType" | "autoCapitalize"
>;

export type InputProps = PassthroughProps & {
  /** Visible label; also the accessible name of the field. */
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  /** Helper text under the field. `error` replaces it while set. */
  hint?: string;
  /** Validation message: danger border, text under the field and the screen-reader hint. */
  error?: string;
  disabled?: boolean;
  /** Layout-only classes for the wrapper (margins, width). */
  className?: string;
  testID?: string;
};

export function Input({
  label,
  value,
  onChangeText,
  hint,
  error,
  disabled = false,
  className,
  testID,
  ...textInputProps
}: InputProps) {
  const hasError = Boolean(error);
  const message = error || hint;

  return (
    <View className={className}>
      <Text className="mb-1.5 text-sm font-medium text-navy">{label}</Text>
      <TextInput
        {...textInputProps}
        accessibilityLabel={label}
        accessibilityHint={message}
        accessibilityState={{ disabled }}
        editable={!disabled}
        value={value}
        onChangeText={onChangeText}
        testID={testID}
        className={cx(
          "min-h-[48px] rounded-xl border bg-white px-4 text-base text-navy",
          hasError ? "border-danger" : "border-gray/40 focus:border-navy",
          disabled && "opacity-50",
        )}
      />
      {message ? (
        <Text
          accessibilityLiveRegion={hasError ? "polite" : "none"}
          className={cx("mt-1 text-sm", hasError ? "text-danger" : "text-gray")}
        >
          {message}
        </Text>
      ) : null}
    </View>
  );
}
