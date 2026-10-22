import type { Ref } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { bubbleShadow, continuousCorners } from "@/theme";

import { cx } from "./cx";
import type { InputHandle } from "./Input";
import { useFlag } from "./useFlag";

export type CodeInputProps = {
  /** Visible label; also the accessible name of the field. */
  label: string;
  /**
   * Digits only; anything else typed or pasted is dropped. A paste or autofill that brings more
   * digits than the cells (a whole SMS, or a code over a half-typed one) keeps its last ones.
   */
  value: string;
  onChangeText: (digits: string) => void;
  /** How many digits the code has: one cell each. */
  length: number;
  /** Validation message: danger ring on every cell, text under them, announced politely. */
  error?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  ref?: Ref<InputHandle>;
  testID?: string;
};

const RING = { rest: "border-transparent", active: "border-green-700", error: "border-danger" };

/**
 * A one-time code as a row of bubble cells. One native field sits transparent over the cells and
 * takes every keystroke, paste and autofill, so the system's code suggestions work as for any
 * field: `oneTimeCode` on iOS, the SMS code autofill hint on Android. The cells only draw what the
 * field holds and are hidden from screen readers, which read the field itself.
 */
export function CodeInput({
  label,
  value,
  onChangeText,
  length,
  error,
  disabled = false,
  autoFocus,
  ref,
  testID,
}: CodeInputProps) {
  const [focused, focus, blur] = useFlag();
  const hasError = Boolean(error);
  // The cell the next digit lands in; with every digit in, the last one keeps the ring.
  const activeCell = Math.min(value.length, length - 1);
  const cells = Array.from({ length }, (_, index) => index);

  const change = (text: string) => {
    const digits = text.replace(/[^0-9]/g, "");
    if (digits.length <= length) onChangeText(digits);
    // More than one character at once is a paste or an autofill: the code is its last digits.
    // One more keystroke on a full field is ignored.
    else if (digits.length - value.length > 1) onChangeText(digits.slice(-length));
  };

  return (
    <View>
      <Text className="mb-2 text-callout font-semibold text-navy-900">{label}</Text>
      <View className={cx(disabled && "opacity-50")}>
        <View
          className="flex-row gap-2"
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
        >
          {cells.map((index) => {
            const ring = hasError
              ? RING.error
              : focused && index === activeCell
                ? RING.active
                : RING.rest;
            return (
              <View
                key={index}
                style={[bubbleShadow, continuousCorners]}
                className={cx(
                  "h-14 flex-1 items-center justify-center rounded-md border-2 bg-white",
                  ring,
                )}
                testID={testID && `${testID}-cell-${index}`}
              >
                <Text className="text-title-2 text-navy-900">{value[index] ?? ""}</Text>
              </View>
            );
          })}
        </View>
        <TextInput
          ref={ref}
          value={value}
          onChangeText={change}
          // No native maxLength: it trims a paste to the cell count before the digits are picked
          // out, so "123-456" or a whole SMS would lose its code. `change` keeps the length.
          // The caret stays after the last digit: a tap on a filled cell must not move it there.
          selection={{ start: value.length, end: value.length }}
          keyboardType="number-pad"
          inputMode="numeric"
          textContentType="oneTimeCode"
          autoComplete="sms-otp"
          importantForAutofill="yes"
          autoFocus={autoFocus}
          editable={!disabled}
          caretHidden
          selectionColor="transparent"
          underlineColorAndroid="transparent"
          accessibilityLabel={label}
          accessibilityHint={error}
          accessibilityState={{ disabled }}
          onFocus={focus}
          onBlur={blur}
          // Covers the cells and draws nothing: the cells show the digits.
          style={[StyleSheet.absoluteFill, styles.invisibleText]}
          testID={testID}
        />
      </View>
      {hasError ? (
        <Text accessibilityLiveRegion="polite" className="mt-1 text-footnote text-danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  invisibleText: { color: "transparent", backgroundColor: "transparent" },
});
