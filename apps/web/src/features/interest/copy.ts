import type { TFunction } from "i18next";

import type { InterestText } from "./types";

/** The form's words in the page's language (`showcase.interest.*`), resolved on the server. */
export function interestText(t: TFunction): InterestText {
  return {
    title: t("showcase.interest.title"),
    hint: t("showcase.interest.hint"),
    label: t("showcase.interest.label"),
    consent: t("showcase.interest.consent"),
    privacy: t("showcase.interest.privacy"),
    submit: t("showcase.interest.submit"),
    sending: t("showcase.interest.sending"),
    joined: t("showcase.interest.joined"),
    honeypot: t("showcase.interest.honeypot"),
    errors: {
      invalid_email: t("showcase.interest.errors.invalid_email"),
      retry: t("showcase.interest.errors.retry"),
      stale: t("showcase.interest.errors.stale"),
      rate_limited: t("showcase.interest.errors.rate_limited"),
      unavailable: t("showcase.interest.errors.unavailable"),
    },
  };
}
