import { ApiError, NetworkError } from "@/api";
import i18n from "@/i18n";

import {
  addedCard,
  brandOf,
  cardName,
  expiryOf,
  maskedNumber,
  shortSpokenCard,
  spokenCard,
  walletFailure,
  walletOrder,
  withDefault,
  withoutCard,
} from "../cards";
import { AMEX, card, DISCOVER, JCB, MASTER, NEW, VISA } from "./helpers";

// The helpers reach the Stripe sheet's module, which registers its reset with the session.
jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  onSignOut: jest.fn(),
}));

const t = i18n.t.bind(i18n);
const ids = (wallet: { id: string; is_default: boolean }[]) =>
  wallet.map((saved) => (saved.is_default ? `${saved.id}*` : saved.id));

afterEach(() => i18n.changeLanguage("en"));

describe("a saved card, as the wallet writes and says it", () => {
  it("draws the four brands it has a mark for, and any other as a plain card", () => {
    expect([VISA, MASTER, AMEX, DISCOVER, JCB].map(brandOf)).toEqual([
      "visa",
      "mastercard",
      "amex",
      "discover",
      "generic",
    ]);
    expect(brandOf(card({ id: "pm_x", brand: "toString" }))).toBe("generic");
  });

  it("writes the expiry as MM/YY and the number as four dots and the last four digits", () => {
    expect(expiryOf(VISA)).toBe("12/28");
    expect(expiryOf(MASTER)).toBe("03/30");
    expect(maskedNumber(AMEX)).toBe("•••• 0005");
    expect(cardName(t, VISA)).toBe("Visa •••• 4242");
    expect(cardName(t, JCB)).toBe("Card •••• 0505");
  });

  it("says the card in full, with no dot read out", () => {
    expect(spokenCard(t, VISA)).toBe("Visa ending 4242, expires 12 28, default");
    expect(spokenCard(t, MASTER)).toBe("Mastercard ending 4444, expires 03 30");
    expect(shortSpokenCard(t, AMEX)).toBe("American Express ending 0005");
  });

  it("says it in Spanish", async () => {
    await i18n.changeLanguage("es");

    expect(spokenCard(t, VISA)).toBe("Visa terminada en 4242, vence 12 28, predeterminada");
    expect(cardName(t, JCB)).toBe("Tarjeta •••• 0505");
  });
});

describe("the wallet's order and its changes", () => {
  it("stacks the default in front, then the API's order", () => {
    expect(ids(walletOrder([MASTER, AMEX, VISA]))).toEqual(["pm_visa*", "pm_master", "pm_amex"]);
    expect(ids(walletOrder([MASTER, AMEX]))).toEqual(["pm_master", "pm_amex"]);
  });

  it("moves the default to one card and off every other", () => {
    expect(ids(withDefault([VISA, MASTER, AMEX], "pm_amex"))).toEqual([
      "pm_visa",
      "pm_master",
      "pm_amex*",
    ]);
  });

  it("takes a card out without naming who is the default next", () => {
    expect(ids(withoutCard([VISA, MASTER, AMEX], "pm_visa"))).toEqual(["pm_master", "pm_amex"]);
  });

  it("finds the card an add saved: the one the wallet did not have before", () => {
    expect(addedCard([VISA, MASTER], [NEW, VISA, MASTER])).toBe(NEW);
    expect(addedCard([], [NEW])).toBe(NEW);
    expect(addedCard([VISA], [VISA])).toBeUndefined();
  });
});

describe("why the wallet could not be read or changed", () => {
  it.each([
    [new NetworkError(false), "offline"],
    [new ApiError(503, "payments_unavailable"), "unavailable"],
    [new ApiError(503, "not_configured"), "unavailable"],
    [new ApiError(429, "rate_limited"), "rateLimited"],
    [new ApiError(404, "payment_method_not_found"), "gone"],
    [new ApiError(404, "not_found"), "generic"],
    [new ApiError(500, "internal_error"), "generic"],
    [new Error("boom"), "generic"],
  ])("%s reads as %s", (error, failure) => {
    expect(walletFailure(error)).toBe(failure);
  });
});
