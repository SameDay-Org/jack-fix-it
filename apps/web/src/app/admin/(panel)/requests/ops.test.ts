import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

import { classifiable, dayIn, dueError, dueTone, OPS_ERRORS, zonedInstant } from "./ops";
import { DEFAULT_FOLLOWUP_MAX_DAYS, followupMaxDays, opsErrorOf } from "./ops-server";

const NY = "America/New_York";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a follow-up's day and time in the business time zone", () => {
  it.each([
    ["a winter day", "2026-01-15", "10:00", "2026-01-15T15:00:00.000Z"],
    ["a summer day", "2026-07-15", "10:00", "2026-07-15T14:00:00.000Z"],
    ["just before the spring change", "2026-03-08", "01:30", "2026-03-08T06:30:00.000Z"],
    [
      "the hour the spring change skips (an hour later, as clocks do)",
      "2026-03-08",
      "02:30",
      "2026-03-08T07:30:00.000Z",
    ],
    ["just after the spring change", "2026-03-08", "03:30", "2026-03-08T07:30:00.000Z"],
    ["just before the autumn change", "2026-11-01", "00:30", "2026-11-01T04:30:00.000Z"],
    [
      "the hour the autumn change repeats (the first one)",
      "2026-11-01",
      "01:30",
      "2026-11-01T05:30:00.000Z",
    ],
    ["just after the autumn change", "2026-11-01", "03:00", "2026-11-01T08:00:00.000Z"],
  ])("on %s", (_case, day, time, iso) => {
    expect(zonedInstant(day, time, NY)?.toISOString()).toBe(iso);
  });

  it("follows the zone it is given, not the server's", () => {
    expect(zonedInstant("2026-01-15", "10:00", "America/Los_Angeles")?.toISOString()).toBe(
      "2026-01-15T18:00:00.000Z",
    );
  });

  it.each([
    ["2026-02-30", "10:00"],
    ["2026-13-01", "10:00"],
    ["2026-02-03", "24:00"],
    ["2026-02-03", "9:00"],
    ["", "10:00"],
    ["2026-02-03", ""],
  ])("is no time for %j %j", (day, time) => {
    expect(zonedInstant(day, time, NY)).toBeNull();
  });
});

describe("a follow-up's due time", () => {
  const now = Date.parse("2026-11-19T15:00:00Z");

  it.each([
    [null, "due_invalid"],
    [new Date(now - 60_000), "due_past"],
    [new Date(now), "due_past"],
    [new Date(now + 60_000), null],
    [new Date(now + 30 * 86_400_000), null],
    [new Date(now + 30 * 86_400_000 + 60_000), "due_too_far"],
  ] as const)("at %s is %s", (due, error) => {
    expect(dueError(due, now, 30)).toBe(error);
  });

  it("reads its window from OPS_FOLLOWUP_MAX_DAYS, the API's 30 by default", () => {
    expect(followupMaxDays()).toBe(DEFAULT_FOLLOWUP_MAX_DAYS);
    expect(DEFAULT_FOLLOWUP_MAX_DAYS).toBe(30);
    vi.stubEnv("OPS_FOLLOWUP_MAX_DAYS", "7");
    expect(followupMaxDays()).toBe(7);
    vi.stubEnv("OPS_FOLLOWUP_MAX_DAYS", "seven");
    expect(followupMaxDays()).toBe(30);
  });

  it("reads overdue, today in the business time zone, or later", () => {
    // 2026-11-19 at 22:00 in New York is 03:00 UTC the next day.
    const late = Date.parse("2026-11-20T03:00:00Z");
    expect(dueTone("2026-11-20T02:00:00Z", late, NY)).toBe("overdue");
    expect(dueTone("2026-11-20T04:30:00Z", late, NY)).toBe("today"); // 23:30 in New York
    expect(dueTone("2026-11-20T05:30:00Z", late, NY)).toBe("later"); // 00:30 the next day
    expect(dayIn(late, NY)).toBe("2026-11-19");
  });
});

describe("classify", () => {
  it.each([
    ["received", true],
    ["reviewing", true],
    ["finding_pro", false],
    ["quote_ready", false],
    ["accepted", false],
    ["expired", false],
    ["cancelled", false],
  ] as const)("in %s is offered: %s", (status, offered) => {
    expect(classifiable(status)).toBe(offered);
  });
});

describe("a refused action", () => {
  it.each([
    [409, "request_held", "request_held"],
    [409, "request_not_classifiable", "request_not_classifiable"],
    [422, "category_inactive", "category_inactive"],
    [422, "followup_due_out_of_range", "followup_due_out_of_range"],
    [422, "assignee_not_staff", "assignee_not_staff"],
    [404, "followup_not_found", "followup_not_found"],
    [404, "request_not_found", "request_not_found"],
    [404, undefined, "request_not_found"],
    [403, "forbidden", "forbidden"],
    [429, "rate_limited", "rate_limited"],
    [422, "validation_error", "validation_error"],
    [500, "internal", "unavailable"],
    [409, "something_new", "unavailable"],
  ] as const)("answering %s %s is %s", (status, code, error) => {
    expect(opsErrorOf(new ApiError(status, code))).toBe(error);
  });

  it("is unconfirmed when the API never answered", () => {
    expect(opsErrorOf(new TypeError("fetch failed"))).toBe("unconfirmed");
  });

  it.each([
    ["en", en],
    ["es", es],
  ] as const)("has a message for every outcome in %s", (_locale, catalog) => {
    expect(Object.keys(catalog.admin.requests.ops.errors).sort()).toEqual([...OPS_ERRORS].sort());
  });
});
