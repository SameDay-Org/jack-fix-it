import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text } from "react-native";

import { Input, type InputProps } from "./Input";

export type PasswordInputProps = Omit<
  InputProps,
  "secureTextEntry" | "accessory" | "autoCapitalize" | "autoCorrect" | "keyboardType" | "inputMode"
>;

/** A secure `Input` with a show/hide toggle inside the field; the caller sets the autofill intent. */
export function PasswordInput({ disabled = false, ...inputProps }: PasswordInputProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  return (
    <Input
      {...inputProps}
      disabled={disabled}
      secureTextEntry={!visible}
      autoCapitalize="none"
      autoCorrect={false}
      accessory={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(visible ? "common.hidePassword" : "common.showPassword")}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => setVisible((shown) => !shown)}
          className="min-h-12 min-w-12 items-center justify-center rounded-pill px-3"
          testID={inputProps.testID && `${inputProps.testID}-toggle`}
        >
          <Text className="text-callout font-semibold text-green-700">
            {t(visible ? "common.hide" : "common.show")}
          </Text>
        </Pressable>
      }
    />
  );
}
