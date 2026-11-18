import { describe, expect, it } from "vitest";

import {
  addDays,
  isIsoDay,
  KPIS_PATH,
  presetDays,
  presetOf,
  RANGE_PRESETS,
  rangeError,
  rangeHref,
  spanDays,
  todayIn,
  toRangeQuery,
} from "./range";

describe("the KPI range in the URL", () => {
  it("offers the last 7, 30 and 90 days", () => {
    expect(RANGE_PRESETS).toEqual([7, 30, 90]);
  });

  it.each([
    [{}, { kind: "default" }],
    [{ days: "7" }, { kind: "preset", days: 7 }],
    [{ days: "90" }, { kind: "preset", days: 90 }],
    [{ days: "14" }, { kind: "default" }],
    [{ days: ["7", "30"] }, { kind: "default" }],
    [
      { from: "2026-10-01", to: "2026-10-31" },
      { kind: "custom", from: "2026-10-01", to: "2026-10-31" },
    ],
    [{ from: "2026-10-01" }, { kind: "custom", from: "2026-10-01", to: "" }],
    [
      { days: "7", to: "2026-10-31" },
      { kind: "custom", from: "", to: "2026-10-31" },
    ],
  ])("reads %j as %j", (query, range) => {
    expect(toRangeQuery(query)).toEqual(range);
  });

  it("writes each range back to a shareable address", () => {
    expect(rangeHref({ kind: "default" })).toBe(KPIS_PATH);
    expect(rangeHref({ kind: "preset", days: 30 })).toBe("/admin/kpis?days=30");
    expect(rangeHref({ kind: "custom", from: "2026-10-01", to: "2026-10-31" })).toBe(
      "/admin/kpis?from=2026-10-01&to=2026-10-31",
    );
    for (const range of [
      { kind: "preset", days: 90 },
      { kind: "custom", from: "2026-01-05", to: "2026-03-01" },
    ] as const) {
      const url = new URL(rangeHref(range), "https://panel.test");
      expect(toRangeQuery(Object.fromEntries(url.searchParams))).toEqual(range);
    }
  });

  it("ends a preset today, both days included", () => {
    expect(presetDays(7, "2026-11-18")).toEqual({ from: "2026-11-12", to: "2026-11-18" });
    expect(presetDays(30, "2026-03-01")).toEqual({ from: "2026-01-31", to: "2026-03-01" });
    expect(spanDays("2026-01-31", "2026-03-01")).toBe(30);
  });

  it("names the preset a range is, only when it ends today", () => {
    expect(presetOf("2026-10-20", "2026-11-18", "2026-11-18")).toBe(30);
    expect(presetOf("2026-10-20", "2026-11-17", "2026-11-18")).toBeNull();
    expect(presetOf("2026-11-05", "2026-11-18", "2026-11-18")).toBeNull();
  });
});

describe("a range the API would refuse", () => {
  it.each([
    ["2026-10-01", "2026-10-31", null],
    ["2026-10-31", "2026-10-31", null],
    ["", "2026-10-31", "missing"],
    ["2026-10-01", "", "missing"],
    ["2026-02-30", "2026-03-01", "missing"],
    ["10/01/2026", "2026-10-31", "missing"],
    ["2026-11-01", "2026-10-31", "order"],
    ["2025-11-18", "2026-11-18", null],
    ["2025-11-17", "2026-11-18", "length"],
  ] as const)("from %s to %s: %s (366 days at most)", (from, to, error) => {
    expect(rangeError(from, to, 366)).toBe(error);
  });

  it("takes its longest range from the setting it is given", () => {
    expect(rangeError("2026-11-12", "2026-11-18", 7)).toBeNull();
    expect(rangeError("2026-11-11", "2026-11-18", 7)).toBe("length");
  });
});

describe("the calendar", () => {
  it("knows real days", () => {
    expect(isIsoDay("2028-02-29")).toBe(true);
    expect(isIsoDay("2026-02-29")).toBe(false);
    expect(isIsoDay("2026-13-01")).toBe(false);
  });

  it("adds days across months and years", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("gives today in the business time zone, not the server's", () => {
    const lateEvening = new Date("2026-11-19T03:30:00Z"); // 22:30 on the 18th in New York
    expect(todayIn("America/New_York", lateEvening)).toBe("2026-11-18");
    expect(todayIn("UTC", lateEvening)).toBe("2026-11-19");
  });
});
