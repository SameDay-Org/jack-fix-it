import Constants from "expo-constants";

/** How the app pays for a quote, read once at startup. */
export type PaymentConfig = {
  /** How often the app asks whether a paid quote's job exists yet, in milliseconds. */
  readonly pollIntervalMs: number;
  /** How long it keeps asking after the sheet reported a payment, in milliseconds. */
  readonly pollTimeoutMs: number;
  /** Apple Pay's merchant id (`extra.appleMerchantId` in app.config.ts); none: no Apple Pay. */
  readonly appleMerchantId: string | undefined;
  /** The app's URL scheme (`scheme` in app.config.ts): where a bank's 3-D Secure page returns. */
  readonly urlScheme: string;
};

export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_POLL_TIMEOUT_MS = 60_000;
const FALLBACK_SCHEME = "jackfixit";

type RawPaymentConfig = {
  pollIntervalMs: string | undefined;
  pollTimeoutMs: string | undefined;
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
  // `scheme` may be a list in an Expo config; the first one is the app's own.
  const scheme = Array.isArray(raw.scheme) ? raw.scheme[0] : raw.scheme;
  return {
    pollIntervalMs,
    pollTimeoutMs,
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
  appleMerchantId: Constants.expoConfig?.extra?.appleMerchantId,
  scheme: Constants.expoConfig?.scheme,
});
