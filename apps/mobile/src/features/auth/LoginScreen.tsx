import { useTranslation } from "react-i18next";

import { login } from "@/api";

import { CredentialsForm } from "./components/CredentialsForm";
import { useCredentialsForm } from "./useCredentialsForm";

/** Email and password; password reset arrives with its own flow (#27), so nothing points there yet. */
export function LoginScreen() {
  const { t } = useTranslation();
  const form = useCredentialsForm(login);

  return (
    <CredentialsForm
      testID="login-screen"
      title={t("login.title")}
      form={form}
      submitLabel={t("login.submit")}
      passwordAutofill={{ textContentType: "password", autoComplete: "current-password" }}
    />
  );
}
