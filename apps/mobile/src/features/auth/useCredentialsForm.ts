import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo } from "react-native";

import { apiConfig } from "@/api";

import { describeAuthFailure, type FieldName } from "./errors";

export type Credentials = { email: string; password: string };
export type FieldErrors = Partial<Record<FieldName, string>>;
/** A failure of the whole form: the message, the fields it points at, and the log-in offer. */
export type FormFailure = { message: string; highlight: FieldName[]; offerLogin: boolean };

export type CredentialsForm = {
  email: string;
  password: string;
  setEmail: (text: string) => void;
  setPassword: (text: string) => void;
  fieldErrors: FieldErrors;
  failure: FormFailure | null;
  submitting: boolean;
  /** Validates on the device first, then submits; errors land on the fields or the form. */
  submitForm: () => Promise<void>;
  passwordMinLength: number;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed and lowercased, the way the account is stored. */
export const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();

/**
 * Email and password state for sign-up and login: client-side validation, one submission at a
 * time, server errors mapped to catalog text and announced to screen readers. Success is the
 * session's to show: the gate switches screens when the status changes.
 */
export function useCredentialsForm(
  submit: (credentials: Credentials) => Promise<void>,
): CredentialsForm {
  const { t } = useTranslation();
  const [email, setEmailState] = useState("");
  const [password, setPasswordState] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // `submitting` is render state, so two submits in the same turn would both read false; the ref
  // is set before the first await and released in `finally`, whatever the outcome.
  const inFlight = useRef(false);
  const passwordMinLength = apiConfig.passwordMinLength;

  const setEmail = useCallback((text: string) => {
    setEmailState(text);
    setFieldErrors((errors) => ({ ...errors, email: undefined }));
    setFailure(null);
  }, []);

  const setPassword = useCallback((text: string) => {
    setPasswordState(text);
    setFieldErrors((errors) => ({ ...errors, password: undefined }));
    setFailure(null);
  }, []);

  const submitForm = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const errors: FieldErrors = {};
      if (!EMAIL_PATTERN.test(normalizeEmail(email))) {
        errors.email = t("auth.errors.emailInvalid");
      }
      if (password.length < passwordMinLength) {
        errors.password = t("auth.errors.passwordTooShort", { min: passwordMinLength });
      }
      const firstError = errors.email ?? errors.password;
      if (firstError) {
        setFieldErrors(errors);
        AccessibilityInfo.announceForAccessibility(firstError);
        return;
      }

      setSubmitting(true);
      try {
        await submit({ email: normalizeEmail(email), password });
      } catch (error) {
        const described = describeAuthFailure(error);
        const message = t(described.messageKey);
        setFailure({
          message,
          highlight: described.highlight ?? [],
          offerLogin: described.offerLogin ?? false,
        });
        AccessibilityInfo.announceForAccessibility(message);
      } finally {
        setSubmitting(false);
      }
    } finally {
      inFlight.current = false;
    }
  }, [email, password, passwordMinLength, submit, t]);

  return {
    email,
    password,
    setEmail,
    setPassword,
    fieldErrors,
    failure,
    submitting,
    submitForm,
    passwordMinLength,
  };
}
