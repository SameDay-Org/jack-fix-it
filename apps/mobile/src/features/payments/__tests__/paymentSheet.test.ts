import {
  initPaymentSheet,
  initStripe,
  PaymentSheetError,
  presentPaymentSheet,
  resetPaymentSheetCustomer,
} from "@stripe/stripe-react-native";

import { deferred } from "../../../api/__tests__/helpers";
import { openPaymentSheet, openSetupSheet } from "../paymentSheet";
import type { PaymentSheetOut } from "../paymentStore";
import { resetSheetCustomer } from "../sheetCustomer";
import { SHEET } from "./helpers";

jest.mock("@stripe/stripe-react-native");
jest.mock("@/api", () => ({ onSignOut: jest.fn() }));
jest.mock("../config", () => {
  const config = {
    pollIntervalMs: 2000,
    pollTimeoutMs: 60000,
    resetTimeoutMs: 10000,
    resetAttempts: 2,
    urlScheme: "jackfixit",
    appleMerchantId: "merchant.com.jackfixit.app" as string | undefined,
  };
  return { paymentConfig: config };
});

const { paymentConfig } = jest.requireMock<{ paymentConfig: { appleMerchantId?: string } }>(
  "../config",
);

const open = (stillWanted = () => true) =>
  openPaymentSheet(SHEET, { merchantName: "John Got It", stillWanted });

beforeEach(() => {
  paymentConfig.appleMerchantId = "merchant.com.jackfixit.app";
  jest.mocked(initStripe).mockReset().mockResolvedValue(undefined);
  jest.mocked(initPaymentSheet).mockReset().mockResolvedValue({});
  jest.mocked(presentPaymentSheet).mockReset().mockResolvedValue({});
  jest.mocked(resetPaymentSheetCustomer).mockReset().mockResolvedValue(null);
});

/** Spies on every console method, so a test can read what was logged. */
const spyOnConsole = () =>
  (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    jest.spyOn(console, method).mockImplementation(),
  );
/** Every console call of the spies, with an Error's name, message and stack spelled out. */
const linesOf = (spies: ReturnType<typeof spyOnConsole>) =>
  spies.flatMap((spy) =>
    spy.mock.calls.map((args) =>
      JSON.stringify(args, (_key, value: unknown) =>
        value instanceof Error
          ? { name: value.name, message: value.message, stack: value.stack }
          : value,
      ),
    ),
  );

const sdkCalls = () => ({
  stripe: jest.mocked(initStripe).mock.calls.length,
  sheet: jest.mocked(initPaymentSheet).mock.calls.length,
  present: jest.mocked(presentPaymentSheet).mock.calls.length,
});
const NONE = { stripe: 0, sheet: 0, present: 0 };

describe("openPaymentSheet", () => {
  it("initializes Stripe with the API's key, the merchant id and the app scheme", async () => {
    await expect(open()).resolves.toEqual({ kind: "paid" });
    expect(initStripe).toHaveBeenCalledWith({
      publishableKey: "pk_test_jack",
      merchantIdentifier: "merchant.com.jackfixit.app",
      urlScheme: "jackfixit",
    });
    expect(initPaymentSheet).toHaveBeenCalledWith(
      expect.objectContaining({
        applePay: { merchantCountryCode: "US" },
        googlePay: { merchantCountryCode: "US", currencyCode: "USD", testEnv: true },
        returnURL: "jackfixit://stripe-redirect",
        appearance: expect.objectContaining({ applyLiquidGlass: true }),
      }),
    );
  });

  it("opens with the customer through the CustomerSession, never the deprecated ephemeral key", async () => {
    await expect(open()).resolves.toEqual({ kind: "paid" });
    const params = jest.mocked(initPaymentSheet).mock.calls[0][0];
    expect(params).toMatchObject({
      customerId: "cus_jack",
      customerSessionClientSecret: "cuss_secret_789",
      paymentIntentClientSecret: "pi_123_secret_456",
      merchantDisplayName: "John Got It",
      allowsDelayedPaymentMethods: false,
    });
    // The API still sends the old key for one release (#436): a sheet given it has full rights.
    expect(params).not.toHaveProperty("customerEphemeralKeySecret");
    expect(JSON.stringify(params)).not.toContain(SHEET.ephemeral_key_secret);
    expect(params).not.toHaveProperty("setupIntentClientSecret");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
  ])(
    "an API without the session's secret (%s) gets the calm failure and opens nothing",
    async (_, secret) => {
      const old = {
        ...SHEET,
        customer_session_client_secret: secret,
      } as unknown as PaymentSheetOut;
      await expect(
        openPaymentSheet(old, { merchantName: "John Got It", stillWanted: () => true }),
      ).resolves.toEqual({ kind: "failed", reason: "unavailable" });
      expect(sdkCalls()).toEqual(NONE);
      expect(resetPaymentSheetCustomer).not.toHaveBeenCalled();
    },
  );

  it("logs no secret of the sheet, whether it opens, fails or cannot open", async () => {
    const spies = spyOnConsole();
    try {
      // Stripe's errors may quote what it was given: their text is never logged either.
      jest
        .mocked(initPaymentSheet)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          error: {
            code: PaymentSheetError.Failed,
            message: `No such customer session: ${SHEET.customer_session_client_secret}`,
          },
        });
      jest.mocked(presentPaymentSheet).mockResolvedValueOnce({
        error: { code: PaymentSheetError.Failed, message: `Declined for ${SHEET.customer_id}` },
      });
      await expect(open()).resolves.toEqual({ kind: "failed", reason: "failed" });
      await expect(open()).resolves.toEqual({ kind: "failed", reason: "unavailable" });
      jest
        .mocked(initStripe)
        .mockRejectedValueOnce(new Error(`Invalid key ${SHEET.publishable_key}`));
      await expect(open()).resolves.toEqual({ kind: "failed", reason: "unavailable" });

      const secrets = [
        SHEET.customer_session_client_secret,
        SHEET.payment_intent_client_secret,
        SHEET.ephemeral_key_secret,
        SHEET.customer_id,
        SHEET.publishable_key,
      ];
      const leaks = linesOf(spies).flatMap((line) =>
        secrets.filter((secret) => line.includes(secret)).map((secret) => ({ secret, line })),
      );
      expect(leaks).toEqual([]);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it("a live key uses Google Pay's production wallet", async () => {
    await openPaymentSheet(
      { ...SHEET, publishable_key: "pk_live_jack" },
      { merchantName: "John Got It", stillWanted: () => true },
    );
    expect(jest.mocked(initPaymentSheet).mock.calls[0][0].googlePay?.testEnv).toBe(false);
  });

  it("without a merchant id the sheet offers no Apple Pay", async () => {
    paymentConfig.appleMerchantId = undefined;
    await open();
    expect(jest.mocked(initPaymentSheet).mock.calls[0][0].applePay).toBeUndefined();
  });

  it("maps the sheet's codes and never passes Stripe's message on", async () => {
    jest
      .mocked(presentPaymentSheet)
      .mockResolvedValueOnce({ error: { code: PaymentSheetError.Canceled, message: "x" } })
      .mockResolvedValueOnce({ error: { code: PaymentSheetError.Failed, message: "card 4242" } })
      .mockResolvedValueOnce({ error: { code: PaymentSheetError.Timeout, message: "slow" } });
    await expect(open()).resolves.toEqual({ kind: "canceled" });
    await expect(open()).resolves.toEqual({ kind: "failed", reason: "failed" });
    await expect(open()).resolves.toEqual({ kind: "failed", reason: "timeout" });
  });

  it("stops before init or present once the caller no longer wants the sheet", async () => {
    await expect(open(() => false)).resolves.toEqual({ kind: "superseded" });
    expect(initPaymentSheet).not.toHaveBeenCalled();

    let wanted = true;
    jest.mocked(initPaymentSheet).mockImplementationOnce(async () => {
      wanted = false;
      return {};
    });
    await expect(open(() => wanted)).resolves.toEqual({ kind: "superseded" });
    expect(presentPaymentSheet).not.toHaveBeenCalled();
  });

  it("opens nothing while an ended session's reset keeps failing, and opens once it succeeds", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      jest.mocked(resetPaymentSheetCustomer).mockRejectedValue(new TypeError("native detail"));
      resetSheetCustomer(); // a sign-out whose reset fails
      await expect(open()).resolves.toEqual({ kind: "failed", reason: "unavailable" });
      expect(sdkCalls()).toEqual(NONE);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("native detail");

      jest.mocked(resetPaymentSheetCustomer).mockResolvedValue(null);
      await expect(open()).resolves.toEqual({ kind: "paid" });
    } finally {
      warn.mockRestore();
    }
  });

  it("a caller that leaves while the reset runs gets nothing opened", async () => {
    const stuck = deferred<null>();
    jest.mocked(resetPaymentSheetCustomer).mockReturnValueOnce(stuck.promise);
    resetSheetCustomer();
    const leaving = new AbortController();
    const result = openPaymentSheet(SHEET, {
      merchantName: "John Got It",
      stillWanted: () => true,
      signal: leaving.signal,
    });
    leaving.abort();
    await expect(result).resolves.toEqual({ kind: "superseded" });
    stuck.resolve(null);
    await expect(open()).resolves.toEqual({ kind: "paid" });
    expect(sdkCalls()).toEqual({ stripe: 1, sheet: 1, present: 1 });
  });
});

describe("openSetupSheet", () => {
  // Recognizable values: the sheet's result and the console never carry one of them.
  const SETUP = {
    client_secret: "seti_123_secret_456",
    customer_id: "cus_jack",
    publishable_key: "pk_test_jack",
  };
  /** What an API from before #253c still put in the answer: the sheet must never use it. */
  const OLD_KEY = "ek_test_789";
  // What the mocked Stripe errors say. Their text may describe the card or carry a secret: only an
  // error's code decides the result, and the text reaches neither the caller nor the console.
  const STRIPE_SAYS = {
    canceled: "The customer closed the sheet",
    declined: "Your card ending 4242 was declined",
    slow: "Stripe took too long to answer",
    init: `No such setupintent: ${SETUP.client_secret}`,
    key: `Invalid API key provided: ${SETUP.publishable_key}`,
    reset: `Could not reset the sign-in of ${SETUP.customer_id}`,
  };
  const NEVER_LOGGED = [...Object.values(SETUP), ...Object.values(STRIPE_SAYS)];

  const save = (stillWanted = () => true) =>
    openSetupSheet(SETUP, { merchantName: "John Got It", stillWanted });

  let consoleSpies: ReturnType<typeof spyOnConsole> = [];
  beforeEach(() => {
    consoleSpies = spyOnConsole();
  });
  afterEach(() => consoleSpies.forEach((spy) => spy.mockRestore()));

  /** Every console call of the test so far. */
  const logged = () => linesOf(consoleSpies);
  /** Fails with each console line that carries a value of SETUP or what Stripe said. */
  const expectNothingLogged = () =>
    expect(
      logged().flatMap((line) =>
        NEVER_LOGGED.filter((value) => line.includes(value)).map((value) => ({ value, line })),
      ),
    ).toEqual([]);

  it("opens the sheet in setup mode without the customer: a SetupIntent, no wallet and no payment", async () => {
    // Even an older API's key, still in the answer, is left out.
    await expect(
      openSetupSheet(
        { ...SETUP, ephemeral_key_secret: OLD_KEY },
        { merchantName: "John Got It", stillWanted: () => true },
      ),
    ).resolves.toEqual({ kind: "saved" });

    expect(initStripe).toHaveBeenCalledWith(
      expect.objectContaining({ publishableKey: "pk_test_jack", urlScheme: "jackfixit" }),
    );
    const params = jest.mocked(initPaymentSheet).mock.calls[0][0];
    expect(params).toMatchObject({
      setupIntentClientSecret: "seti_123_secret_456",
      merchantDisplayName: "John Got It",
      returnURL: "jackfixit://stripe-redirect",
      allowsDelayedPaymentMethods: false,
    });
    // Given the customer, Stripe's sheet would list their saved cards and let them remove one.
    expect(params).not.toHaveProperty("customerId");
    expect(params).not.toHaveProperty("customerEphemeralKeySecret");
    expect(JSON.stringify(params)).not.toContain(SETUP.customer_id);
    expect(params).not.toHaveProperty("customerSessionClientSecret");
    expect(JSON.stringify(params)).not.toContain(OLD_KEY);
    expect(params.paymentIntentClientSecret).toBeUndefined();
    // Apple Pay and Google Pay are not saved cards.
    expect(params.applePay).toBeUndefined();
    expect(params.googlePay).toBeUndefined();
    expect(presentPaymentSheet).toHaveBeenCalledTimes(1);
    expectNothingLogged();
  });

  it("maps how the sheet ended, and passes Stripe's message on to neither the caller nor the console", async () => {
    jest
      .mocked(presentPaymentSheet)
      .mockResolvedValueOnce({
        error: { code: PaymentSheetError.Canceled, message: STRIPE_SAYS.canceled },
      })
      .mockResolvedValueOnce({
        error: { code: PaymentSheetError.Failed, message: STRIPE_SAYS.declined },
      })
      .mockResolvedValueOnce({
        error: { code: PaymentSheetError.Timeout, message: STRIPE_SAYS.slow },
      });
    await expect(save()).resolves.toEqual({ kind: "canceled" });
    expectNothingLogged();
    await expect(save()).resolves.toEqual({ kind: "failed", reason: "failed" });
    expectNothingLogged();
    await expect(save()).resolves.toEqual({ kind: "failed", reason: "timeout" });
    expectNothingLogged();
  });

  it("a sheet that cannot open is unavailable, and logs neither Stripe's message nor a secret", async () => {
    // initPaymentSheet answers with an error...
    jest.mocked(initPaymentSheet).mockResolvedValueOnce({
      error: { code: PaymentSheetError.Failed, message: STRIPE_SAYS.init },
    });
    await expect(save()).resolves.toEqual({ kind: "failed", reason: "unavailable" });
    expect(presentPaymentSheet).not.toHaveBeenCalled();
    expectNothingLogged();

    // ...and initStripe rejects on a key it cannot use.
    jest.mocked(initStripe).mockRejectedValueOnce(new Error(STRIPE_SAYS.key));
    await expect(save()).resolves.toEqual({ kind: "failed", reason: "unavailable" });
    expect(sdkCalls()).toEqual({ stripe: 2, sheet: 1, present: 0 });
    expectNothingLogged();
  });

  it("opens nothing while an ended session's reset keeps failing, and logs only the error's class", async () => {
    jest.mocked(resetPaymentSheetCustomer).mockRejectedValue(new TypeError(STRIPE_SAYS.reset));
    resetSheetCustomer(); // a sign-out whose reset fails
    await expect(save()).resolves.toEqual({ kind: "failed", reason: "unavailable" });
    expect(sdkCalls()).toEqual(NONE);
    // The watch sees the reset's warning, so what the warning leaves out is really checked.
    expect(logged()).toContainEqual(
      expect.stringContaining("Payment sheet reset failed: TypeError"),
    );
    expectNothingLogged();

    jest.mocked(resetPaymentSheetCustomer).mockResolvedValue(null);
    await expect(save()).resolves.toEqual({ kind: "saved" });
    expectNothingLogged();
  });

  it("opens nothing once the caller no longer wants the sheet, before init or after it", async () => {
    await expect(save(() => false)).resolves.toEqual({ kind: "superseded" });
    expect(sdkCalls()).toEqual(NONE);
    expectNothingLogged();

    let wanted = true;
    jest.mocked(initPaymentSheet).mockImplementationOnce(async () => {
      wanted = false;
      return {};
    });
    await expect(save(() => wanted)).resolves.toEqual({ kind: "superseded" });
    expect(presentPaymentSheet).not.toHaveBeenCalled();
    expectNothingLogged();
  });
});
