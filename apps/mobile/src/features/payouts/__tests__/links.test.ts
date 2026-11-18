import { redirectSystemPath } from "../../quotes/links";
import {
  isPayoutsReturn,
  PAYOUTS_HREF,
  PAYOUTS_RETURN_URL,
  PAYOUTS_ROUTE,
  payoutsReturnResult,
  payoutsReturnRoute,
} from "../links";

jest.mock("@stripe/stripe-react-native");

const running = (path: string) => redirectSystemPath({ path, initial: false });
const coldStart = (path: string) => redirectSystemPath({ path, initial: true });

describe("the return link of payout setup", () => {
  it("is the app's scheme and the path the API's pages redirect to", () => {
    // PAYOUTS_ONBOARDING_APP_URL on the API (`jackfixit://payouts` in every environment).
    expect(PAYOUTS_RETURN_URL).toBe("jackfixit://payouts");
    expect(PAYOUTS_HREF).toBe(`/${PAYOUTS_ROUTE}`);
  });

  it.each([
    ["payouts", true],
    ["payouts/", true],
    ["payouts?result=return", true],
    ["payouts/?result=refresh", true],
    ["payouts#x", true],
    ["payouts/extra", false],
    ["payoutsx", false],
    ["pro/payouts", false],
    ["", false],
  ])("isPayoutsReturn(%j) is %s", (rest, expected) => {
    expect(isPayoutsReturn(rest)).toBe(expected);
  });

  it.each([
    ["jackfixit://payouts?result=return", "return"],
    ["jackfixit://payouts?result=refresh", "refresh"],
    ["jackfixit://payouts?x=1&result=refresh#top", "refresh"],
    ["jackfixit://payouts", null],
    ["jackfixit://payouts?result=", null],
    ["jackfixit://payouts?result=returned", null],
    ["jackfixit://payouts?result=https://evil.test", null],
    ["jackfixit://payouts?xresult=return", null],
  ])("payoutsReturnResult(%j) is %j", (url, expected) => {
    expect(payoutsReturnResult(url)).toBe(expected);
  });

  it("keeps the result it knows and nothing else of the link", () => {
    expect(payoutsReturnRoute("payouts?result=return")).toBe("pro/payouts?result=return");
    expect(payoutsReturnRoute("payouts?result=refresh&next=//evil.test")).toBe(
      "pro/payouts?result=refresh",
    );
    expect(payoutsReturnRoute("payouts?result=..%2F..%2Fdev")).toBe("pro/payouts");
    expect(payoutsReturnRoute("payouts")).toBe("pro/payouts");
  });
});

describe("redirectSystemPath: back from payout setup (#277)", () => {
  it("opens the payout screen in the running app, with the result", () => {
    expect(running("jackfixit://payouts?result=return")).toBe(
      "jackfixit://pro/payouts?result=return",
    );
    expect(running("jackfixit://payouts?result=refresh")).toBe(
      "jackfixit://pro/payouts?result=refresh",
    );
    expect(running("/payouts?result=return")).toBe("/pro/payouts?result=return");
  });

  it("opens it on a cold start too: the app may have been closed under the browser", () => {
    expect(coldStart("jackfixit://payouts?result=return")).toBe(
      "jackfixit://pro/payouts?result=return",
    );
  });

  it("drops whatever else a forged link carries", () => {
    expect(running("jackfixit://payouts?result=evil&redirect=https://evil.test")).toBe(
      "jackfixit://pro/payouts",
    );
    expect(running("jackfixit://payouts")).toBe("jackfixit://pro/payouts");
  });

  it("leaves other links alone, a web host that looks like it included", () => {
    expect(running("https://payouts?result=return")).toBe("https://payouts?result=return");
    expect(running("jackfixit://payouts/extra")).toBe("jackfixit://payouts/extra");
    expect(running("jackfixit://pro/payouts")).toBe("jackfixit://pro/payouts");
  });
});
