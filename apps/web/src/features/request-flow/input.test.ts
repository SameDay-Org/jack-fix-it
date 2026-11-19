import { describe, expect, it } from "vitest";

import { descriptionFits, emailInput, phoneInput, zipInput } from "./input";

describe("zipInput", () => {
  it.each([
    ["33301", "33301"],
    [" 33301 ", "33301"],
    ["33301-1234", "33301-1234"],
  ])("takes %j as %j", (typed, zip) => {
    expect(zipInput(typed)).toBe(zip);
  });

  it.each(["", "3330", "333011", "33301-12", "3330a", "33301 1234", "<b>33301</b>", 33301, null])(
    "refuses %j",
    (typed) => {
      expect(zipInput(typed)).toBeNull();
    },
  );
});

describe("emailInput", () => {
  it("trims and lowercases an address", () => {
    expect(emailInput("  Ana.P@Example.COM ")).toBe("ana.p@example.com");
  });

  it.each(["", "ana", "ana@", "@example.com", "ana@example", "ana p@example.com", 42])(
    "refuses %j",
    (typed) => {
      expect(emailInput(typed)).toBeNull();
    },
  );

  it("refuses an address longer than the API stores", () => {
    expect(emailInput(`${"a".repeat(310)}@example.com`)).toBeNull();
  });
});

describe("phoneInput", () => {
  it.each([
    "(954) 555-0100",
    "954-555-0100",
    "954.555.0100",
    "9545550100",
    "+1 954 555 0100",
    "1 954 555 0100",
  ])("takes %j as E.164 with the calling code", (typed) => {
    expect(phoneInput(typed, "+1")).toBe("+19545550100");
  });

  it.each([
    "",
    "555-0100",
    "054 555 0100", // an area code never starts with 0 or 1
    "954 155 0100", // nor does an exchange
    "+44 20 7946 0958",
    "95455501001",
    "x".repeat(41),
    42,
  ])("refuses %j", (typed) => {
    expect(phoneInput(typed, "+1")).toBeNull();
  });
});

describe("descriptionFits", () => {
  it("needs something besides spaces, up to 2000 characters once trimmed", () => {
    expect(descriptionFits("The kitchen sink leaks.")).toBe(true);
    expect(descriptionFits("   ")).toBe(false);
    expect(descriptionFits(` ${"a".repeat(2000)} `)).toBe(true);
    expect(descriptionFits("a".repeat(2001))).toBe(false);
  });
});
