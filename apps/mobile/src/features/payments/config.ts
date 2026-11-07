import Constants from "expo-constants";

/** How the app pays for a quote, read once at startup. */
export type PaymentConfig = {
  /** How often the app asks whether a paid quote's job exists yet, in milliseconds. */
  readonly pollIntervalMs: number;
  /** How long it keeps asking after the sheet reported a payment, in milliseconds. */
  readonly pollTimeoutMs: number;
  /** How long a sheet waits for Stripe's customer reset of an ended session, in milliseconds. */
  readonly resetTimeoutMs: number;
  /** How many times a sheet tries that reset again when it failed before; then Pay says so. */
  readonly resetAttempts: number;
  /** Apple Pay's merchant id (`extra.appleMerchantId` in app.config.ts); none: no Apple Pay. */
  readonly appleMerchantId: string | undefined;
  /** The app's URL scheme (`scheme` in app.config.ts): where a bank's 3-D Secure page returns. */
  readonly urlScheme: string;
};

export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_POLL_TIMEOUT_MS = 60_000;
export const DEFAULT_RESET_TIMEOUT_MS = 10_000;
export const DEFAULT_RESET_ATTEMPTS = 2;
const FALLBACK_SCHEME = "jackfixit";

type RawPaymentConfig = {
  pollIntervalMs: string | undefined;
  pollTimeoutMs: string | undefined;
  resetTimeoutMs: string | undefined;
  resetAttempts: string | undefined;
  appleMerchantId: unknown;
  scheme: unknown;
};

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number`);
  }
  return value;
}

/** Validates the raw values. Pure, so tests can cover every branch. */
export function readPaymentConfig(raw: RawPaymentConfig): PaymentConfig {
  const pollIntervalMs = positiveInteger(
    raw.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    "EXPO_PUBLIC_PAYMENT_POLL_INTERVAL_MS",
  );
  const pollTimeoutMs = positiveInteger(
    raw.pollTimeoutMs,
    DEFAULT_POLL_TIMEOUT_MS,
    "EXPO_PUBLIC_PAYMENT_POLL_TIMEOUT_MS",
  );
  if (pollTimeoutMs < pollIntervalMs) {
    throw new Error("EXPO_PUBLIC_PAYMENT_POLL_TIMEOUT_MS must not be shorter than the interval");
  }
  const resetTimeoutMs = positiveInteger(
    raw.resetTimeoutMs,
    DEFAULT_RESET_TIMEOUT_MS,
    "EXPO_PUBLIC_PAYMENT_RESET_TIMEOUT_MS",
  );
  const resetAttempts = positiveInteger(
    raw.resetAttempts,
    DEFAULT_RESET_ATTEMPTS,
    "EXPO_PUBLIC_PAYMENT_RESET_ATTEMPTS",
  );
  // `scheme` may be a list in an Expo config; the first one is the app's own.
  const scheme = Array.isArray(raw.scheme) ? raw.scheme[0] : raw.scheme;
  return {
    pollIntervalMs,
    pollTimeoutMs,
    resetTimeoutMs,
    resetAttempts,
    appleMerchantId:
      typeof raw.appleMerchantId === "string" && raw.appleMerchantId !== ""
        ? raw.appleMerchantId
        : undefined,
    urlScheme: typeof scheme === "string" && scheme !== "" ? scheme : FALLBACK_SCHEME,
  };
}

// Literal `process.env.EXPO_PUBLIC_*` reads: Metro inlines them at build time.
export const paymentConfig: PaymentConfig = readPaymentConfig({
  pollIntervalMs: process.env.EXPO_PUBLIC_PAYMENT_POLL_INTERVAL_MS,
  pollTimeoutMs: process.env.EXPO_PUBLIC_PAYMENT_POLL_TIMEOUT_MS,
  resetTimeoutMs: process.env.EXPO_PUBLIC_PAYMENT_RESET_TIMEOUT_MS,
  resetAttempts: process.env.EXPO_PUBLIC_PAYMENT_RESET_ATTEMPTS,
  appleMerchantId: Constants.expoConfig?.extra?.appleMerchantId,
  scheme: Constants.expoConfig?.scheme,
});
