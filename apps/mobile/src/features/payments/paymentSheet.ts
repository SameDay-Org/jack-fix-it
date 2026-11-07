import {
  initPaymentSheet,
  initStripe,
  PaymentSheetError,
  presentPaymentSheet,
  type AppearanceParams,
} from "@stripe/stripe-react-native";

import { tokens } from "@/theme";

import { paymentConfig } from "./config";
import type { PaymentSheetOut } from "./paymentStore";

/** Where the platform's business is registered: Apple Pay and Google Pay need its country. */
const MERCHANT_COUNTRY = "US";
/** Live keys start with this; any other key is Stripe's test mode, and Google Pay's test wallet. */
const LIVE_KEY_PREFIX = "pk_live_";
/** The path a bank's 3-D Secure page returns to (`links.ts` hands it to Stripe, not the router). */
export const STRIPE_RETURN_PATH = "stripe-redirect";

/**
 * How the sheet ended: `paid` (Stripe confirmed the PaymentIntent); `canceled` (the customer
 * closed it); `failed` with why (`failed`: Stripe could not take the payment, `timeout`: it took
 * too long, `unavailable`: the sheet could not open); `superseded` (the session or the screen
 * that asked for it ended before it opened: nothing was shown).
 */
export type SheetResult =
  | { kind: "paid" }
  | { kind: "canceled" }
  | { kind: "failed"; reason: "failed" | "timeout" | "unavailable" }
  | { kind: "superseded" };

// The brand on Stripe's own sheet: navy text and accents, the green pill of the app's primary
// button (navy on green-500, AA), rounded fields, and Liquid Glass where iOS 26 has it.
const PILL_HEIGHT = 48;
const APPEARANCE: AppearanceParams = {
  applyLiquidGlass: true,
  colors: {
    primary: tokens.colors["navy-900"],
    primaryText: tokens.colors["navy-900"],
    secondaryText: tokens.colors["gray-500"],
    error: tokens.colors.danger,
  },
  shapes: { borderRadius: tokens.radius.sm },
  primaryButton: {
    colors: { background: tokens.colors["green-500"], text: tokens.colors["navy-900"] },
    shapes: { borderRadius: PILL_HEIGHT / 2, height: PILL_HEIGHT },
  },
};

/**
 * Opens Stripe's Payment Sheet for what the API prepared and waits for the customer. Card data
 * goes from the sheet to Stripe and never through this code, and neither secret is logged, kept
 * or returned. `stillWanted` is asked after every step that waits: once it says no (the session
 * ended, the screen went away) nothing more is opened. Stripe's error text is never passed on,
 * since it may describe the card: only the error's code decides the result.
 */
export async function openPaymentSheet(
  sheet: PaymentSheetOut,
  { merchantName, stillWanted }: { merchantName: string; stillWanted: () => boolean },
): Promise<SheetResult> {
  try {
    await initStripe({
      publishableKey: sheet.publishable_key,
      merchantIdentifier: paymentConfig.appleMerchantId,
      urlScheme: paymentConfig.urlScheme,
    });
    if (!stillWanted()) return { kind: "superseded" };

    const init = await initPaymentSheet({
      merchantDisplayName: merchantName,
      customerId: sheet.customer_id,
      customerEphemeralKeySecret: sheet.ephemeral_key_secret,
      paymentIntentClientSecret: sheet.payment_intent_client_secret,
      allowsDelayedPaymentMethods: false,
      returnURL: `${paymentConfig.urlScheme}://${STRIPE_RETURN_PATH}`,
      applePay: paymentConfig.appleMerchantId
        ? { merchantCountryCode: MERCHANT_COUNTRY }
        : undefined,
      googlePay: {
        merchantCountryCode: MERCHANT_COUNTRY,
        currencyCode: sheet.currency.toUpperCase(),
        testEnv: !sheet.publishable_key.startsWith(LIVE_KEY_PREFIX),
      },
      appearance: APPEARANCE,
    });
    if (init.error) return { kind: "failed", reason: "unavailable" };
    if (!stillWanted()) return { kind: "superseded" };

    const { error } = await presentPaymentSheet();
    if (!error) return { kind: "paid" };
    if (error.code === PaymentSheetError.Canceled) return { kind: "canceled" };
    return {
      kind: "failed",
      reason: error.code === PaymentSheetError.Timeout ? "timeout" : "failed",
    };
  } catch {
    // initStripe rejects on a key it cannot use; the other two answer with `error` instead.
    return { kind: "failed", reason: "unavailable" };
  }
}
