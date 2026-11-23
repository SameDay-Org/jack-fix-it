import { requiredSecret } from "@/lib/public-form/settings";

import type { StoreLinks } from "./types";

// The request flow's server settings (#86, handoffs/86-draft-spec.md §3, §1). Read on the server
// only: the secrets never reach a client component (request-flow.test.ts checks the imports).

/**
 * The flow's two secrets, required once it is on: REQUEST_FORM_SECRET signs the form's token
 * (lib/public-form/form-token.ts) and never leaves this server; WEB_SERVICE_KEY tells the API
 * that a call comes from this web service (lib/public-form/visitor.ts), the only caller whose
 * visitor address it trusts. A missing or short one fails the page: a form that cannot be sent
 * is never shown.
 */
export function requestFlowSecrets(): { formSecret: string; webServiceKey: string } {
  return {
    formSecret: requiredSecret("REQUEST_FORM_SECRET"),
    webServiceKey: requiredSecret("WEB_SERVICE_KEY"),
  };
}

function httpsUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The app's store pages for the "sent" screen's invitation to make an account in the app:
 * APP_STORE_URL and PLAY_STORE_URL, both https. Set them once the app is in the stores; until
 * then the screen links to /app. (Claiming a web request from a later account is post-MVP: the
 * screen promises nothing about it.)
 */
export function storeLinks(): StoreLinks | null {
  const appStore = httpsUrl(process.env.APP_STORE_URL);
  const playStore = httpsUrl(process.env.PLAY_STORE_URL);
  return appStore && playStore ? { appStore, playStore } : null;
}

/**
 * Which consent text the visitor saw (`request.review.consent`), stored with the request. A
 * change of those words is a new version: legal approves the text before the flag goes on.
 */
export const CONSENT_VERSION = "request-contact-2026-11-23";
