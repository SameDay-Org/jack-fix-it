import { ApiError, NetworkError } from "@/api";
import type en from "@/i18n/locales/en.json";

export type FieldName = "email" | "password";

type AuthErrorKey = `auth.errors.${Exclude<keyof (typeof en)["auth"]["errors"], "loginInstead">}`;

export type AuthFailure = {
  messageKey: AuthErrorKey;
  /** Fields the message is about; they get the danger ring while the text sits with the form. */
  highlight?: FieldName[];
  /** The account exists already: offer to log in instead. */
  offerLogin?: boolean;
};

// Server codes from the auth contract (#25, #28). Anything else gets the generic line: a raw server
// message is never shown.
const BY_CODE: Readonly<Record<string, AuthFailure>> = {
  invalid_credentials: { messageKey: "auth.errors.invalidCredentials" },
  email_already_registered: {
    messageKey: "auth.errors.emailTaken",
    highlight: ["email"],
    offerLogin: true,
  },
  account_suspended: { messageKey: "auth.errors.suspended" },
  rate_limited: { messageKey: "auth.errors.rateLimited" },
  // Email format and password length are checked on the device first, so what is left cannot be
  // attributed to one field: both are marked.
  validation_error: { messageKey: "auth.errors.checkFields", highlight: ["email", "password"] },
};

/** The message a sign-up or login failure gets, as a catalog key. */
export function describeAuthFailure(error: unknown): AuthFailure {
  if (error instanceof NetworkError) return { messageKey: "auth.errors.offline" };
  if (error instanceof ApiError && error.code !== undefined && Object.hasOwn(BY_CODE, error.code)) {
    return BY_CODE[error.code];
  }
  return { messageKey: "auth.errors.generic" };
}
