import { describe, expect, it } from "vitest";

import {
  dayInput,
  descriptionFits,
  emailInput,
  firstDay,
  lineInput,
  localToday,
  nameInput,
  phoneInput,
  stateInput,
  utcToday,
  zipInput,
} from "./input";

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

describe("the address, the day and the names (W1b)", () => {
  it("nameInput: letters with their accents, spaces, hyphens, apostrophes, periods", () => {
    expect(nameInput("  María   José ")).toBe("María José");
    for (const name of ["O'Neil", "Pérez-Gómez", "St. John", "D\u2019Angelo", "Nguyễn"]) {
      expect(nameInput(name), name).toBe(name);
    }
    for (const name of [
      "",
      "  ",
      "Ana 954",
      "ana@example.com",
      "-",
      "<b>Ana</b>",
      "a".repeat(61),
      7,
    ]) {
      expect(nameInput(name), String(name)).toBeNull();
    }
  });

  it("lineInput and stateInput", () => {
    expect(lineInput(" 100 Las Olas Blvd ", 255)).toBe("100 Las Olas Blvd");
    expect(lineInput("", 255)).toBeNull();
    expect(lineInput("a".repeat(256), 255)).toBeNull();
    expect(lineInput("line\u0000", 255)).toBeNull();
    expect(stateInput(" fl ")).toBe("FL");
    for (const state of ["F", "FLA", "F1", "Florida", ""])
      expect(stateInput(state), state).toBeNull();
  });

  it("firstDay: the later of the visitor's today and the UTC one", () => {
    // 9 pm in Florida is already tomorrow in UTC: the API would refuse the local today.
    const evening = new Date("2026-11-20T02:00:00Z");
    expect(utcToday(evening)).toBe("2026-11-20");
    expect(firstDay(evening) >= utcToday(evening)).toBe(true);
    expect(firstDay(evening) >= localToday(evening)).toBe(true);
  });

  it("dayInput: a real day, from the first one on", () => {
    expect(dayInput("2026-11-20", "2026-11-20")).toBe("2026-11-20");
    expect(dayInput("2026-11-19", "2026-11-20")).toBeNull();
    for (const day of ["2026-02-30", "2026-13-01", "20261120", "tomorrow", "", 20261120]) {
      expect(dayInput(day, "2026-01-01"), String(day)).toBeNull();
    }
  });
});
