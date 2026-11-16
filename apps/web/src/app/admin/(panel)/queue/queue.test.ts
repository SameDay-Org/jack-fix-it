import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ageOf,
  apiQuery,
  awaitsFirstContact,
  contactLinks,
  contactTimer,
  formatClock,
  formatUsd,
  queueHref,
  queueRefreshMs,
  toFilters,
  toTab,
} from "./queue";
import { CATEGORY_ID } from "./queue-test-helpers";

afterEach(() => vi.unstubAllEnvs());

describe("the queue's URL", () => {
  it.each([
    [undefined, "new"],
    ["urgent", "urgent"],
    ["mine", "mine"],
    ["all", "all"],
    ["other", "new"],
    [["urgent", "all"], "new"],
  ])("reads the tab %j as %s", (value, tab) => {
    expect(toTab(value)).toBe(tab);
  });

  it("keeps only the filters the API accepts", () => {
    expect(
      toFilters({
        status: "finding_pro",
        category_id: CATEGORY_ID,
        zip: " 33301 ",
        assigned: "unassigned",
        q: "jf-0001",
      }),
    ).toEqual({
      status: "finding_pro",
      categoryId: CATEGORY_ID,
      zip: "33301",
      assigned: "unassigned",
      q: "jf-0001",
    });
    expect(
      toFilters({
        status: "paid",
        category_id: "plumbing",
        zip: "3330",
        assigned: "any",
        q: "JF-%",
      }),
    ).toEqual({});
    expect(toFilters({ zip: "33301-1234", q: "x".repeat(17), status: ["received"] })).toEqual({});
  });

  it("asks the API for a bucket, or for the reader's own requests", () => {
    expect(apiQuery("urgent", { zip: "33301", assigned: "unassigned" }, "cur")).toEqual({
      bucket: "urgent",
      zip: "33301",
      assigned: "unassigned",
      cursor: "cur",
    });
    // Mine: every request the reader holds, whatever the filter said about who holds it.
    expect(apiQuery("mine", { assigned: "unassigned", q: "JF-1" }, undefined)).toEqual({
      bucket: "all",
      assigned: "me",
      q: "JF-1",
    });
  });

  it("writes a tab and its filters back into a link", () => {
    expect(queueHref("new")).toBe("/admin/queue");
    expect(queueHref("problems", { zip: "33301", q: "JF-1" }, "next/cur+sor")).toBe(
      "/admin/queue?tab=problems&zip=33301&q=JF-1&cursor=next%2Fcur%2Bsor",
    );
    expect(queueHref("mine", { assigned: "unassigned", status: "received" })).toBe(
      "/admin/queue?tab=mine&status=received",
    );
  });

  it("reads the refresh interval from the environment, half a minute otherwise", () => {
    expect(queueRefreshMs()).toBe(30_000);
    vi.stubEnv("QUEUE_REFRESH_SECONDS", "45");
    expect(queueRefreshMs()).toBe(45_000);
    for (const bad of ["0", "-5", "1.5", "soon", ""]) {
      vi.stubEnv("QUEUE_REFRESH_SECONDS", bad);
      expect(queueRefreshMs()).toBe(30_000);
    }
  });
});

describe("the first-contact timer", () => {
  const created = "2026-11-07T14:00:00Z";
  const due = "2026-11-07T14:10:00Z";
  const at = (clock: string) => Date.parse(`2026-11-07T${clock}Z`);

  it.each([
    ["14:00:00", 600, "calm"],
    ["14:04:59", 301, "calm"],
    ["14:05:00", 300, "soon"],
    ["14:09:59", 1, "soon"],
    ["14:10:00", 0, "late"],
    ["14:12:30", -150, "late"],
  ] as const)("at %s has %i seconds and is %s", (clock, seconds, tone) => {
    expect(contactTimer(at(clock), created, due)).toEqual({ seconds, tone });
  });

  it.each([
    [0, "0:00"],
    [247, "4:07"],
    [-150, "2:30"],
    [3_600, "1h 00m"],
    [7_500, "2h 05m"],
    [90_000, "1d 1h"],
  ])("writes %i seconds as %s", (seconds, text) => {
    expect(formatClock(seconds)).toBe(text);
  });

  it.each([
    ["received", null, true],
    ["reviewing", null, true],
    ["received", "2026-11-07T14:03:00Z", false],
    ["finding_pro", null, false],
    ["quote_ready", null, false],
    ["cancelled", null, false],
  ] as const)("runs for %s contacted at %s: %s", (status, first_contact_at, runs) => {
    expect(awaitsFirstContact({ status, first_contact_at })).toBe(runs);
  });
});

describe("what a row shows", () => {
  it.each([
    ["14:00:30", { unit: "minutes", count: 0 }],
    ["14:59:59", { unit: "minutes", count: 59 }],
    ["15:00:00", { unit: "hours", count: 1 }],
  ])("tells the age at %s", (clock, age) => {
    expect(ageOf("2026-11-07T14:00:00Z", Date.parse(`2026-11-07T${clock}Z`))).toEqual(age);
  });

  it("tells the age in days, and never a negative one", () => {
    const created = "2026-11-07T14:00:00Z";
    expect(ageOf(created, Date.parse("2026-11-10T15:00:00Z"))).toEqual({ unit: "days", count: 3 });
    expect(ageOf(created, Date.parse("2026-11-07T13:59:00Z"))).toEqual({
      unit: "minutes",
      count: 0,
    });
  });

  it("writes cents as dollars", () => {
    expect(formatUsd(18_550, "en")).toBe("$185.50");
  });
});

describe("the links that reach a customer", () => {
  it("builds tel, sms and mailto from an E.164 phone and the email", () => {
    expect(contactLinks({ phone: "+13055550181", email: "ana@example.com" })).toEqual({
      tel: "tel:+13055550181",
      sms: "sms:+13055550181",
      mailto: "mailto:ana@example.com",
    });
  });

  it.each([null, "", "305-555-0181", "+1 305 555 0181", "+13055550181?body=x", "javascript:x"])(
    "gives no phone link for %j",
    (phone) => {
      const links = contactLinks({ phone, email: "ana@example.com" });
      expect([links.tel, links.sms]).toEqual([null, null]);
    },
  );

  it("encodes an email so it cannot add a header or another recipient", () => {
    const { mailto } = contactLinks({ phone: null, email: "a@x.com?bcc=evil@x.com&subject=hi" });
    // One literal @, before the last domain: the rest is data, not syntax.
    expect(mailto).toBe("mailto:a%40x.com%3Fbcc%3Devil@x.com%26subject%3Dhi");
    expect(contactLinks({ phone: null, email: "ana+tag@example.com" }).mailto).toBe(
      "mailto:ana%2Btag@example.com",
    );
  });

  it.each(["", "no-at-sign", "@example.com", "ana@"])("gives no mail link for %j", (email) => {
    expect(contactLinks({ phone: null, email }).mailto).toBeNull();
  });
});
