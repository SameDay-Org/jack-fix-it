import {
  initPaymentSheet,
  initStripe,
  PaymentSheetError,
  presentPaymentSheet,
  type AppearanceParams,
  type SetupParams,
} from "@stripe/stripe-react-native";

import { tokens } from "@/theme";

import { paymentConfig } from "./config";
import type { ApiSchema } from "@jack/shared";

import type { PaymentSheetOut } from "./paymentStore";
import { resetSheetCustomer, sheetCustomerReady } from "./sheetCustomer";
import { STRIPE_RETURN_PATH } from "./stripeReturn";

/** Where the platform's business is registered: Apple Pay and Google Pay need its country. */
const MERCHANT_COUNTRY = "US";
/** Live keys start with this; any other key is Stripe's test mode, and Google Pay's test wallet. */
const LIVE_KEY_PREFIX = "pk_live_";

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

/** What the API hands over for the sheet to save a card (`POST /v1/me/payment-methods/setup-intent`). */
export type SetupIntentOut = ApiSchema<"SetupIntentOut">;

/** How a card-saving sheet ended: `saved` (Stripe confirmed the SetupIntent), or as a payment's. */
export type SetupResult = Exclude<SheetResult, { kind: "paid" }> | { kind: "saved" };

type SheetOptions = { merchantName: string; stillWanted: () => boolean; signal?: AbortSignal };
/** What every sheet of the app is opened with, whatever it is for. */
type SharedParams = Pick<SetupParams, "merchantDisplayName" | "returnURL" | "appearance">;

/**
 * Opens Stripe's Payment Sheet for what the API prepared and waits for the customer. Card data goes
 * from the sheet to Stripe and never through this code, and neither secret is logged, kept or
 * returned. `stillWanted` is asked after every step that waits: once it says no (the session ended,
 * the screen went away) nothing more is opened; `signal` ends the wait for the reset early.
 * Stripe's error text is never passed on, since it may describe the card: only the error's code
 * decides the result. The sheet starts only after the customer resets of earlier sessions succeeded
 * (`sheetCustomer`), and does not open when they could not (`unavailable`); when its own session
 * ends while Stripe is working, the reset is asked for again once Stripe is done.
 */
async function runSheet(
  publishableKey: string,
  params: (shared: SharedParams) => SetupParams,
  { merchantName, stillWanted, signal }: SheetOptions,
): Promise<SheetResult> {
  const session = await sheetCustomerReady(signal);
  if (session.kind === "unavailable") return { kind: "failed", reason: "unavailable" };
  if (session.kind === "ended") return { kind: "superseded" };
  const wanted = () => !session.ended() && stillWanted();
  if (!wanted()) return { kind: "superseded" };
  try {
    await initStripe({
      publishableKey,
      merchantIdentifier: paymentConfig.appleMerchantId,
      urlScheme: paymentConfig.urlScheme,
    });
    if (!wanted()) return { kind: "superseded" };

    const init = await initPaymentSheet(
      params({
        merchantDisplayName: merchantName,
        returnURL: `${paymentConfig.urlScheme}://${STRIPE_RETURN_PATH}`,
        appearance: APPEARANCE,
      }),
    );
    if (init.error) return { kind: "failed", reason: "unavailable" };
    if (!wanted()) return { kind: "superseded" };

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
  } finally {
    // Stripe may have saved this customer's sign-in after the reset ran: reset it again.
    if (session.ended()) resetSheetCustomer();
  }
}

/** The sheet that takes a payment for a quote (#59): see `runSheet` for what it promises. */
export function openPaymentSheet(
  sheet: PaymentSheetOut,
  options: SheetOptions,
): Promise<SheetResult> {
  return runSheet(
    sheet.publishable_key,
    (shared) => ({
      ...shared,
      customerId: sheet.customer_id,
      customerEphemeralKeySecret: sheet.ephemeral_key_secret,
      paymentIntentClientSecret: sheet.payment_intent_client_secret,
      allowsDelayedPaymentMethods: false,
      applePay: paymentConfig.appleMerchantId
        ? { merchantCountryCode: MERCHANT_COUNTRY }
        : undefined,
      googlePay: {
        merchantCountryCode: MERCHANT_COUNTRY,
        currencyCode: sheet.currency.toUpperCase(),
        testEnv: !sheet.publishable_key.startsWith(LIVE_KEY_PREFIX),
      },
    }),
    options,
  );
}

/**
 * The same sheet in setup mode (#253): it saves a card on the customer and charges nothing. No
 * Apple Pay or Google Pay here: a wallet is not a saved card. The card goes from the sheet to
 * Stripe; this code only learns how the sheet ended.
 *
 * It opens without the customer (no customer id, no ephemeral key): the API created the SetupIntent
 * on the customer, so Stripe attaches the card it confirms to them all the same. Given the customer,
 * Stripe's sheet would also list their saved cards, let them remove one (a detach that skips the
 * API's delete and its choice of the next default) or pick one again ("saved" with no new card).
 * Without it the sheet is only the form for a new card, and the wallet changes only through the API.
 */
export async function openSetupSheet(
  setup: SetupIntentOut,
  options: SheetOptions,
): Promise<SetupResult> {
  const result = await runSheet(
    setup.publishable_key,
    (shared) => ({
      ...shared,
      setupIntentClientSecret: setup.client_secret,
      allowsDelayedPaymentMethods: false,
    }),
    options,
  );
  return result.kind === "paid" ? { kind: "saved" } : result;
}
