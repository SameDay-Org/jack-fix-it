import { handleURLCallback } from "@stripe/stripe-react-native";

/**
 * The path a bank's 3-D Secure page returns to (`links.ts` hands it to Stripe, not the router).
 * It lives here, not with the sheet, so the link handler loads neither the sheet nor the API.
 */
export const STRIPE_RETURN_PATH = "stripe-redirect";

/**
 * Whether a link's path (after the app's prefix) is where a bank's 3-D Secure page sends the
 * customer back to the Payment Sheet: exactly `stripe-redirect`, with or without a query.
 */
export function isStripeReturn(rest: string): boolean {
  const end = rest.search(/[/?#]/);
  return (end === -1 ? rest : rest.slice(0, end)) === STRIPE_RETURN_PATH;
}

/**
 * Hands that link to Stripe, which finishes the authentication inside its sheet (iOS; Android's
 * SDK takes its own returns). The router never navigates to it. Never throws.
 */
export function handleStripeReturn(url: string): void {
  void handleURLCallback(url).catch(() => undefined);
}
