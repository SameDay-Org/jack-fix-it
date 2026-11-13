import {
  defaultStartAt,
  draftProblems,
  emptyDraft,
  firstProblem,
  isDirty,
  quoteBody,
  recheckCaps,
  type QuoteCaps,
  type QuoteDraft,
} from "../quoteDraft";

/** Local times, so the cases hold in any time zone the tests run in. */
const local = (month: number, day: number, hour: number, minute = 0) =>
  new Date(2026, month - 1, day, hour, minute).getTime();

const NOW = local(10, 28, 10, 20);

const NO_CAPS: QuoteCaps = { quote_max_amount_cents: null, quote_max_duration_minutes: null };
/** $2,500 and 8 h, as the API's examples. */
const CAPS: QuoteCaps = { quote_max_amount_cents: 250_000, quote_max_duration_minutes: 480 };

const filled = (overrides: Partial<QuoteDraft> = {}): QuoteDraft => ({
  price: "100.50",
  scope: "  Paint the hallway and two bedrooms.  ",
  approach: "",
  durationMinutes: 150,
  startAt: local(10, 30, 9),
  ...overrides,
});

describe("defaultStartAt", () => {
  it("is the customer's preferred day at 9:00 AM while that is ahead", () => {
    expect(defaultStartAt("2026-10-30", NOW)).toBe(local(10, 30, 9));
  });

  it("is the next whole hour when the preferred 9:00 AM has passed", () => {
    expect(defaultStartAt("2026-10-28", NOW)).toBe(local(10, 28, 11));
    expect(defaultStartAt("2026-10-01", NOW)).toBe(local(10, 28, 11));
  });

  it("is the next whole hour without a preferred day, also on the hour", () => {
    expect(defaultStartAt(null, NOW)).toBe(local(10, 28, 11));
    expect(defaultStartAt(null, local(10, 28, 23))).toBe(local(10, 29, 0));
  });
});

describe("draftProblems", () => {
  it("finds nothing in a complete draft", () => {
    expect(draftProblems(filled(), NOW, NO_CAPS)).toEqual({});
  });

  it("marks every empty field of a new draft", () => {
    expect(draftProblems(emptyDraft(local(10, 28, 11)), NOW, NO_CAPS)).toEqual({
      price: "required",
      scope: "required",
      duration: "required",
    });
  });

  it.each([
    ["abc", "invalid"],
    ["0", "invalid"],
    ["0.00", "invalid"],
    ["   ", "required"],
    ["21,474,836.48", "aboveCap"],
  ])("price %p is %p", (price, problem) => {
    expect(draftProblems(filled({ price }), NOW, NO_CAPS).price).toBe(problem);
  });

  it("accepts the largest amount the API takes", () => {
    expect(draftProblems(filled({ price: "21,474,836.47" }), NOW, NO_CAPS)).toEqual({});
  });

  it("passes a price and a duration at the caps, the caps themselves included", () => {
    expect(draftProblems(filled({ price: "2,500.00", durationMinutes: 480 }), NOW, CAPS)).toEqual(
      {},
    );
  });

  it("marks one cent and one minute above the caps with the opportunity's limit", () => {
    expect(draftProblems(filled({ price: "2500.01" }), NOW, CAPS)).toEqual({ price: "aboveMax" });
    expect(draftProblems(filled({ durationMinutes: 481 }), NOW, CAPS)).toEqual({
      duration: "aboveMax",
    });
  });

  it("names the cap over the API's largest amount when both are passed", () => {
    expect(draftProblems(filled({ price: "21,474,836.48" }), NOW, CAPS).price).toBe("aboveMax");
  });

  it("checks each cap on its own, and a missing one never blocks", () => {
    const amountOnly = { ...NO_CAPS, quote_max_amount_cents: 250_000 };
    const durationOnly = { ...NO_CAPS, quote_max_duration_minutes: 480 };
    const big = filled({ price: "2500.01", durationMinutes: 481 });
    expect(draftProblems(big, NOW, amountOnly)).toEqual({ price: "aboveMax" });
    expect(draftProblems(big, NOW, durationOnly)).toEqual({ duration: "aboveMax" });
    expect(draftProblems(filled({ durationMinutes: 100_000 }), NOW, NO_CAPS)).toEqual({});
  });

  it("asks for a duration before it checks the cap", () => {
    expect(draftProblems(filled({ durationMinutes: 0 }), NOW, CAPS).duration).toBe("required");
  });

  it("refuses a blank scope and a start that is not ahead", () => {
    expect(draftProblems(filled({ scope: " \n " }), NOW, NO_CAPS)).toEqual({ scope: "required" });
    expect(draftProblems(filled({ startAt: NOW }), NOW, NO_CAPS)).toEqual({ start: "past" });
  });
});

describe("recheckCaps", () => {
  it("checks the price and the duration again and keeps the other marks as found", () => {
    const draft = filled({ price: "2500.01", durationMinutes: 481 });
    const found = { ...draftProblems(draft, NOW, CAPS), scope: "required" as const };
    expect(recheckCaps(found, draft, NO_CAPS)).toEqual({ scope: "required" });
    expect(recheckCaps({ start: "past" }, draft, CAPS)).toEqual({
      price: "aboveMax",
      duration: "aboveMax",
      start: "past",
    });
  });
});

describe("firstProblem", () => {
  it("is the first field down the form, whatever order the problems were found in", () => {
    expect(firstProblem({})).toBeUndefined();
    expect(firstProblem({ start: "past", duration: "aboveMax" })).toBe("duration");
    expect(firstProblem({ duration: "required", scope: "required", price: "aboveMax" })).toBe(
      "price",
    );
    expect(firstProblem({ start: "past", scope: "required" })).toBe("scope");
    expect(firstProblem({ start: "past" })).toBe("start");
  });
});

describe("quoteBody", () => {
  it("builds the exact QuoteCreate, trimmed, without a blank approach", () => {
    expect(quoteBody(filled({ approach: "  \n " }))).toEqual({
      amount_cents: 10_050,
      scope: "Paint the hallway and two bedrooms.",
      duration_minutes: 150,
      proposed_start_at: new Date(local(10, 30, 9)).toISOString(),
    });
    expect(quoteBody(filled({ approach: "  \n " }))).not.toHaveProperty("approach");
  });

  it("sends the approach trimmed when there is one", () => {
    expect(quoteBody(filled({ approach: " Two coats, low-VOC paint. " })).approach).toBe(
      "Two coats, low-VOC paint.",
    );
  });

  it("refuses a draft whose price is not valid", () => {
    expect(() => quoteBody(filled({ price: "abc" }))).toThrow(RangeError);
  });
});

describe("isDirty", () => {
  const initial = emptyDraft(local(10, 30, 9));

  it("is clean as opened and with only spaces typed", () => {
    expect(isDirty(initial, initial)).toBe(false);
    expect(isDirty({ ...initial, scope: "   " }, initial)).toBe(false);
  });

  it.each<[string, Partial<QuoteDraft>]>([
    ["a price", { price: "1" }],
    ["a scope", { scope: "x" }],
    ["an approach", { approach: "x" }],
    ["a duration", { durationMinutes: 15 }],
    ["another start", { startAt: local(10, 31, 9) }],
  ])("is dirty with %s", (_, change) => {
    expect(isDirty({ ...initial, ...change }, initial)).toBe(true);
  });
});
