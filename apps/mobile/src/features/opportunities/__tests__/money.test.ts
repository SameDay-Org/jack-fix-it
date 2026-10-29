import { MAX_AMOUNT_CENTS, parsePriceCents, priceText, split } from "../money";

describe("split", () => {
  // The server's examples (apps/api tests of split_amount at the 15% take rate).
  it.each([
    [10_000, 1500, 8500, 1500],
    [9999, 1500, 8499, 1500],
    [1, 1500, 1, 0],
    // Half a cent of fee rounds up: 10 cents at 15% is a 1.5-cent fee.
    [10, 1500, 8, 2],
    [0, 1500, 0, 0],
    [10_000, 0, 10_000, 0],
    [10_000, 10_000, 0, 10_000],
  ])("%i cents at %i bps → payout %i, fee %i", (amount, bps, payout, fee) => {
    expect(split(amount, bps)).toEqual({ proPayoutCents: payout, platformFeeCents: fee });
  });

  it("always adds up to the amount, the fee never negative or above it", () => {
    for (const bps of [0, 1, 999, 1250, 1500, 3333, 9999, 10_000]) {
      for (let amount = 0; amount <= 2_000; amount += 7) {
        const { proPayoutCents, platformFeeCents } = split(amount, bps);
        expect(proPayoutCents + platformFeeCents).toBe(amount);
        expect(platformFeeCents).toBeGreaterThanOrEqual(0);
        expect(platformFeeCents).toBeLessThanOrEqual(amount);
        expect(Number.isInteger(platformFeeCents)).toBe(true);
      }
    }
    expect(split(MAX_AMOUNT_CENTS, 1500)).toEqual({
      proPayoutCents: 1_825_361_100,
      platformFeeCents: 322_122_547,
    });
  });

  it.each([
    [-1, 1500],
    [1.5, 1500],
    [100, -1],
    [100, 10_001],
    [100, 15.5],
  ])("refuses %p cents at %p bps", (amount, bps) => {
    expect(() => split(amount, bps)).toThrow(RangeError);
  });
});

describe("parsePriceCents", () => {
  it.each([
    ["100", 10_000],
    ["100.5", 10_050],
    ["100.55", 10_055],
    ["1,000.00", 100_000],
    ["1000", 100_000],
    ["100.", 10_000],
    [" 85.10 ", 8510],
    ["0.29", 29],
    ["0.57", 57],
    ["1.15", 115],
    ["4.35", 435],
    ["12,345,678.99", 1_234_567_899],
    ["0", 0],
  ])("%p → %i cents, exactly", (text, cents) => {
    expect(parsePriceCents(text)).toBe(cents);
  });

  it.each(["", "abc", "1,00", "100,5", "100.555", "$100", "-5", ".5", "1e3", "10 0", "1,000,0"])(
    "%p is not a price",
    (text) => {
      expect(parsePriceCents(text)).toBeNull();
    },
  );

  it("never drifts by a cent where float math would", () => {
    // 0.29 * 100 is 28.999999999999996 and 1.15 * 100 is 114.99999999999999 in floating point.
    for (let cents = 0; cents < 10_000; cents += 1) {
      expect(parsePriceCents(priceText(cents))).toBe(cents);
    }
  });
});

describe("priceText", () => {
  it.each([
    [10_000, "100.00"],
    [10_050, "100.50"],
    [5, "0.05"],
    [100_000, "1,000.00"],
  ])("%i cents → %p", (cents, text) => {
    expect(priceText(cents)).toBe(text);
  });
});
