import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_RESET_ATTEMPTS,
  DEFAULT_RESET_TIMEOUT_MS,
  readPaymentConfig,
} from "../config";

const raw = (overrides: Partial<Parameters<typeof readPaymentConfig>[0]> = {}) => ({
  pollIntervalMs: undefined,
  pollTimeoutMs: undefined,
  resetTimeoutMs: undefined,
  resetAttempts: undefined,
  appleMerchantId: "merchant.com.jackfixit.app",
  scheme: "jackfixit",
  ...overrides,
});

describe("readPaymentConfig", () => {
  it("defaults the polling and reads the app config", () => {
    expect(readPaymentConfig(raw())).toEqual({
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      pollTimeoutMs: DEFAULT_POLL_TIMEOUT_MS,
      resetTimeoutMs: DEFAULT_RESET_TIMEOUT_MS,
      resetAttempts: DEFAULT_RESET_ATTEMPTS,
      appleMerchantId: "merchant.com.jackfixit.app",
      urlScheme: "jackfixit",
    });
  });

  it("takes the environment's polling values", () => {
    expect(readPaymentConfig(raw({ pollIntervalMs: "500", pollTimeoutMs: "9000" }))).toMatchObject({
      pollIntervalMs: 500,
      pollTimeoutMs: 9000,
    });
  });

  it.each([["0"], ["-1"], ["1.5"], ["abc"]])("refuses %s as a polling value", (value) => {
    expect(() => readPaymentConfig(raw({ pollIntervalMs: value }))).toThrow(
      "EXPO_PUBLIC_PAYMENT_POLL_INTERVAL_MS must be a positive whole number",
    );
    expect(() => readPaymentConfig(raw({ pollTimeoutMs: value }))).toThrow(
      "EXPO_PUBLIC_PAYMENT_POLL_TIMEOUT_MS must be a positive whole number",
    );
  });

  it("takes the environment's reset wait and tries", () => {
    expect(readPaymentConfig(raw({ resetTimeoutMs: "4000", resetAttempts: "3" }))).toMatchObject({
      resetTimeoutMs: 4000,
      resetAttempts: 3,
    });
  });

  it.each([["0"], ["-1"], ["1.5"], ["abc"]])("refuses %s as a reset value", (value) => {
    expect(() => readPaymentConfig(raw({ resetTimeoutMs: value }))).toThrow(
      "EXPO_PUBLIC_PAYMENT_RESET_TIMEOUT_MS must be a positive whole number",
    );
    expect(() => readPaymentConfig(raw({ resetAttempts: value }))).toThrow(
      "EXPO_PUBLIC_PAYMENT_RESET_ATTEMPTS must be a positive whole number",
    );
  });

  it("refuses a wait shorter than one interval", () => {
    expect(() => readPaymentConfig(raw({ pollIntervalMs: "5000", pollTimeoutMs: "1000" }))).toThrow(
      "must not be shorter than the interval",
    );
  });

  it("no merchant id means no Apple Pay; a scheme list uses its first entry", () => {
    expect(readPaymentConfig(raw({ appleMerchantId: undefined })).appleMerchantId).toBeUndefined();
    expect(readPaymentConfig(raw({ appleMerchantId: "" })).appleMerchantId).toBeUndefined();
    expect(readPaymentConfig(raw({ scheme: ["jackfixit", "other"] })).urlScheme).toBe("jackfixit");
    expect(readPaymentConfig(raw({ scheme: undefined })).urlScheme).toBe("jackfixit");
  });
});
