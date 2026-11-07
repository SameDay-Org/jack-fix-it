import { useRef, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { View, type TextInputProps } from "react-native";

import { Input, PasswordInput, type InputHandle } from "@/components/ui";

import type { CredentialsForm } from "../useCredentialsForm";
import { FormError } from "./FormError";

export type CredentialsFieldsProps = {
  form: CredentialsForm;
  /** Autofill intent of the password field: a new password on sign-up, the current one on login. */
  passwordAutofill: Pick<TextInputProps, "textContentType" | "autoComplete">;
  passwordHint?: string;
  onLoginInstead?: () => void;
  /** Prefixes the fields' ids: `${testID}-email`, `${testID}-password`, `${testID}-error`. */
  testID: string;
  /** The email field, for a parent that moves focus into the form. */
  ref?: Ref<InputHandle>;
};

/**
 * The form's failure, then email and password. Return moves from email to password, then submits.
 */
export function CredentialsFields({
  form,
  passwordAutofill,
  passwordHint,
  onLoginInstead,
  testID,
  ref: emailRef,
}: CredentialsFieldsProps) {
  const { t } = useTranslation();
  const passwordRef = useRef<InputHandle>(null);
  const highlighted = (field: "email" | "password") =>
    form.failure?.highlight.includes(field) ?? false;

  return (
    <>
      <FormError
        failure={form.failure}
        onLoginInstead={onLoginInstead}
        testID={`${testID}-error`}
      />
      <View className="gap-4">
        <Input
          ref={emailRef}
          label={t("fields.email")}
          value={form.email}
          onChangeText={form.setEmail}
          error={form.fieldErrors.email}
          invalid={highlighted("email")}
          disabled={form.submitting}
          keyboardType="email-address"
          inputMode="email"
          autoComplete="email"
          textContentType="emailAddress"
          autoCapitalize="none"
          autoCorrect={false}
          importantForAutofill="yes"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => passwordRef.current?.focus()}
          testID={`${testID}-email`}
        />
        <PasswordInput
          ref={passwordRef}
          label={t("fields.password")}
          value={form.password}
          onChangeText={form.setPassword}
          error={form.fieldErrors.password}
          invalid={highlighted("password")}
          hint={passwordHint}
          disabled={form.submitting}
          {...passwordAutofill}
          importantForAutofill="yes"
          returnKeyType="done"
          submitBehavior="blurAndSubmit"
          onSubmitEditing={() => void form.submitForm()}
          testID={`${testID}-password`}
        />
      </View>
    </>
  );
}
