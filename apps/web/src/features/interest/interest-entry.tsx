import type { TFunction } from "i18next";

import { PRIVACY_PATHS } from "@/features/site/routes";
import type { Locale } from "@/i18n/config";

import { interestToken, joinInterest } from "./actions";
import { interestFormEnabled, interestSecrets } from "./config";
import { interestText } from "./copy";
import { InterestForm } from "./interest-form";

/**
 * The seam for the app-launch interest form (#409) on the showcase page: nothing while
 * INTEREST_FORM_ENABLED is off. On, its secrets are required when the page is built (a form that
 * could not be sent is never shown).
 */
export function InterestEntry({ t, locale }: { t: TFunction; locale: Locale }) {
  if (!interestFormEnabled()) return null;
  interestSecrets();
  return (
    <InterestForm
      locale={locale}
      text={interestText(t)}
      privacyHref={PRIVACY_PATHS[locale]}
      getToken={interestToken}
      join={joinInterest}
    />
  );
}
