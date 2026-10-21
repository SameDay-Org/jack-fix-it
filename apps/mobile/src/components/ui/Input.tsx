import { Text, TextInput, View, type TextInputProps } from "react-native";

import { bubbleShadow, continuousCorners } from "@/theme";

import { cx } from "./cx";
import { useFlag } from "./useFlag";

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
  /** Validation message: danger ring, text under the field and the screen-reader hint. */
  error?: string;
  disabled?: boolean;
  /** Layout-only classes for the wrapper (margins, width). */
  className?: string;
  testID?: string;
};

// The field is a white bubble lifted by the shadow, with no hairline at rest. The 2 px ring is
// always present so the size never changes: transparent at rest, green-700 focused, danger on error.
const RING = { rest: "border-transparent", focused: "border-green-700", error: "border-danger" };

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
  const [focused, focus, blur] = useFlag();
  const hasError = Boolean(error);
  const message = error || hint;
  const ring = hasError ? RING.error : focused ? RING.focused : RING.rest;

  return (
    <View className={className}>
      <Text className="mb-2 text-callout font-semibold text-navy-900">{label}</Text>
      <TextInput
        {...textInputProps}
        accessibilityLabel={label}
        accessibilityHint={message}
        accessibilityState={{ disabled }}
        editable={!disabled}
        value={value}
        onChangeText={onChangeText}
        onFocus={focus}
        onBlur={blur}
        testID={testID}
        style={[bubbleShadow, continuousCorners]}
        className={cx(
          "min-h-12 rounded-md border-2 bg-white px-4 text-body text-navy-900",
          ring,
          disabled && "opacity-50",
        )}
      />
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
