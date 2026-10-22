import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { register } from "@/api";
import { offerPhoneStepAfterSignUp, withdrawPhoneStepOffer } from "@/features/phone/phoneFlow";

import { CredentialsForm } from "./components/CredentialsForm";
import { deviceLocale } from "./locale";
import { isSignUpRole, type SignUpRole } from "./roles";
import { useCredentialsForm, type Credentials } from "./useCredentialsForm";

/** Reads the role chosen on the previous screen; without a valid one it goes back there. */
export function SignUpScreen() {
  const { role } = useLocalSearchParams<{ role?: string }>();
  if (!isSignUpRole(role)) return <Redirect href="/(auth)/role" />;
  return <SignUpForm role={role} />;
}

function SignUpForm({ role }: { role: SignUpRole }) {
  const { t } = useTranslation();
  // The offer goes up before the request: the session turns signed-in inside `register`, and the
  // gate reads it on that render to land on the phone step.
  const submit = useCallback(
    async (credentials: Credentials) => {
      offerPhoneStepAfterSignUp();
      try {
        await register({ ...credentials, role, locale: deviceLocale() });
      } catch (error) {
        withdrawPhoneStepOffer();
        throw error;
      }
    },
    [role],
  );
  const form = useCredentialsForm(submit);

  return (
    <CredentialsForm
      testID="sign-up-screen"
      title={t("signUp.title")}
      subtitle={t(role === "customer" ? "signUp.asCustomer" : "signUp.asPro")}
      form={form}
      submitLabel={t("signUp.submit")}
      passwordAutofill={{ textContentType: "newPassword", autoComplete: "new-password" }}
      passwordHint={t("fields.passwordHint", { min: form.passwordMinLength })}
      onLoginInstead={() => router.replace("/(auth)/login")}
    />
  );
}
