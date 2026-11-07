import {
  initPaymentSheet,
  initStripe,
  PaymentSheetError,
  presentPaymentSheet,
} from "@stripe/stripe-react-native";

import { openPaymentSheet } from "../paymentSheet";
import { SHEET } from "./helpers";

jest.mock("@stripe/stripe-react-native");
jest.mock("@/api", () => ({ onSignOut: jest.fn() }));
jest.mock("../config", () => {
  const config = {
    pollIntervalMs: 2000,
    pollTimeoutMs: 60000,
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
});

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
});
