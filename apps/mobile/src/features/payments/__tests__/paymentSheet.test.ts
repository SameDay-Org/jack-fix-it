import {
  initPaymentSheet,
  initStripe,
  PaymentSheetError,
  presentPaymentSheet,
  resetPaymentSheetCustomer,
} from "@stripe/stripe-react-native";

import { deferred } from "../../../api/__tests__/helpers";
import { openPaymentSheet } from "../paymentSheet";
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
  openPaymentSheet(SHEET, { merchantName: "Jack Fix It", stillWanted });

beforeEach(() => {
  paymentConfig.appleMerchantId = "merchant.com.jackfixit.app";
  jest.mocked(initStripe).mockReset().mockResolvedValue(undefined);
  jest.mocked(initPaymentSheet).mockReset().mockResolvedValue({});
  jest.mocked(presentPaymentSheet).mockReset().mockResolvedValue({});
  jest.mocked(resetPaymentSheetCustomer).mockReset().mockResolvedValue(null);
});

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

  it("a live key uses Google Pay's production wallet", async () => {
    await openPaymentSheet(
      { ...SHEET, publishable_key: "pk_live_jack" },
      { merchantName: "Jack Fix It", stillWanted: () => true },
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
      merchantName: "Jack Fix It",
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
