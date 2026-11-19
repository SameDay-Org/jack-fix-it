import { requiredSecret } from "@/lib/public-form/settings";

// The app-launch interest list's settings (#409). Server only.

/**
 * Whether the showcase page (/app, /es/app) carries the "tell me when the app is out" form:
 * INTEREST_FORM_ENABLED exactly "true", once POST /v1/interest exists (#409's API). Off by
 * default: no form without a working endpoint. The page is built ahead, so a change needs a
 * deploy; the form's server actions read it on every call.
 */
export function interestFormEnabled(): boolean {
  return process.env.INTEREST_FORM_ENABLED === "true";
}

/**
 * The form's two secrets, required once it is on: INTEREST_FORM_SECRET signs its token and never
 * leaves this server; WEB_SERVICE_KEY tells the API the call comes from this web service, the
 * only caller whose visitor address it trusts.
 */
export function interestSecrets(): { formSecret: string; webServiceKey: string } {
  return {
    formSecret: requiredSecret("INTEREST_FORM_SECRET"),
    webServiceKey: requiredSecret("WEB_SERVICE_KEY"),
  };
}

/**
 * Which consent words the visitor saw (`showcase.interest.consent`), stored with the email. A
 * change of those words is a new version: legal approves the text before the form goes on.
 */
export const INTEREST_CONSENT_VERSION = "interest-2026-11-19";
