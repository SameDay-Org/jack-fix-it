import { addDays, dayParts, firstDay, formatLongDay, isPastDay, offeredDays } from "../dates";

/** `iso` in UTC, read on a phone whose own calendar says `local` (any machine's time zone). */
function at(iso: string, local: { year: number; month: number; day: number }): Date {
  return Object.assign(new Date(iso), {
    getFullYear: () => local.year,
    getMonth: () => local.month - 1,
    getDate: () => local.day,
  });
}

// 10 pm on Oct 29 in New York is already Oct 30 in UTC.
const NEW_YORK_EVENING = at("2026-10-30T02:00:00Z", { year: 2026, month: 10, day: 29 });
// 8 am on Oct 30 in Tokyo is still Oct 29 in UTC.
const TOKYO_MORNING = at("2026-10-29T23:00:00Z", { year: 2026, month: 10, day: 30 });
const NEW_YORK_NOON = at("2026-10-29T16:00:00Z", { year: 2026, month: 10, day: 29 });

describe("the days the When step offers", () => {
  it("starts at the API's today (UTC) once it is ahead of the phone's", () => {
    expect(firstDay(NEW_YORK_EVENING)).toBe("2026-10-30");
    expect(firstDay(NEW_YORK_NOON)).toBe("2026-10-29");
  });

  it("never offers a day already over on the phone's calendar", () => {
    expect(firstDay(TOKYO_MORNING)).toBe("2026-10-30");
  });

  it("offers `count` consecutive days, across a month's end", () => {
    expect(offeredDays(3, NEW_YORK_EVENING)).toStrictEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
    expect(offeredDays(30, NEW_YORK_NOON)).toHaveLength(30);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("calls a day past once the strip no longer offers it", () => {
    expect(isPastDay("2026-10-29", NEW_YORK_EVENING)).toBe(true);
    expect(isPastDay("2026-10-30", NEW_YORK_EVENING)).toBe(false);
    expect(isPastDay("2026-10-29", NEW_YORK_NOON)).toBe(false);
  });
});

describe("a day in words", () => {
  it("spells the day in the app's language, never shifted by the time zone", () => {
    expect(formatLongDay("2026-10-30", "en")).toBe("Friday, October 30");
    expect(formatLongDay("2026-10-30", "es")).toBe("viernes, 30 de octubre");
    expect(dayParts("2026-11-01", "en")).toStrictEqual({ weekday: "Sun", date: "1", month: "Nov" });
    expect(dayParts("2026-11-01", "es")).toMatchObject({ weekday: "dom", date: "1" });
  });
});
