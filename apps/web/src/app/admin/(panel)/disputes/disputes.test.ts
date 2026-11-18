import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

import {
  DEFAULT_DISPUTE_AGE_LATE_HOURS,
  DEFAULT_DISPUTE_AGE_WARN_HOURS,
  disputeAgeLimits,
} from "./config";
import {
  ageUnit,
  amountError,
  disputeAge,
  dollarsToCents,
  formatMoney,
  listHref,
  NOTE_MAX_LENGTH,
  photoHref,
  refundState,
  RESOLVE_ERRORS,
  toFilter,
} from "./disputes";
import { DISPUTE_ID, hoursAgo, NOW, PHOTO_ID, refund } from "./disputes-test-helpers";
import { resolveBodyOf, resolveErrorOf } from "./resolve";

afterEach(() => {
  vi.unstubAllEnvs();
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

describe("the list's filter", () => {
  it.each([
    [undefined, "open"],
    ["open", "open"],
    ["resolved", "resolved"],
    ["closed", "open"],
    [["resolved", "open"], "open"],
  ] as const)("reads ?status=%s as %s", (value, filter) => {
    expect(toFilter(value as string | string[] | undefined)).toBe(filter);
  });

  it("writes each view's address", () => {
    expect(listHref("open")).toBe("/admin/disputes");
    expect(listHref("resolved")).toBe("/admin/disputes?status=resolved");
  });
});

describe("a dispute's age", () => {
  const limits = { warnHours: 24, lateHours: 48 };

  it.each([
    [3, "calm"],
    [23.9, "calm"],
    [24, "warn"],
    [47.9, "warn"],
    [48, "late"],
    [100, "late"],
  ] as const)("after %s h is %s", (hours, tone) => {
    expect(disputeAge(NOW, hoursAgo(hours), limits).tone).toBe(tone);
  });

  it("follows the limits it is given", () => {
    expect(disputeAge(NOW, hoursAgo(5), { warnHours: 4, lateHours: 6 }).tone).toBe("warn");
  });

  it.each([
    [0, { unit: "minutes", count: 1 }],
    [59, { unit: "minutes", count: 59 }],
    [60, { unit: "hours", count: 1 }],
    [47 * 60 + 59, { unit: "hours", count: 47 }],
    [48 * 60, { unit: "days", count: 2 }],
  ] as const)("says %s minutes in its unit", (minutes, said) => {
    expect(ageUnit(Math.max(1, minutes))).toEqual(
      minutes === 0 ? { unit: "minutes", count: 1 } : said,
    );
  });
});

describe("the age settings", () => {
  it("default to 24 and 48 hours", () => {
    expect(disputeAgeLimits()).toEqual({ warnHours: 24, lateHours: 48 });
    expect([DEFAULT_DISPUTE_AGE_WARN_HOURS, DEFAULT_DISPUTE_AGE_LATE_HOURS]).toEqual([24, 48]);
  });

  it("take DISPUTE_AGE_WARN_HOURS and DISPUTE_AGE_LATE_HOURS", () => {
    vi.stubEnv("DISPUTE_AGE_WARN_HOURS", "12");
    vi.stubEnv("DISPUTE_AGE_LATE_HOURS", "36");
    expect(disputeAgeLimits()).toEqual({ warnHours: 12, lateHours: 36 });
  });

  it.each([
    ["", "", 24, 48],
    ["abc", "-3", 24, 48],
    ["1.5", "0", 24, 48],
    ["60", "", 24, 48], // red would come before amber: both defaults
  ])("fall back for %j and %j", (warn, late, warnHours, lateHours) => {
    vi.stubEnv("DISPUTE_AGE_WARN_HOURS", warn);
    vi.stubEnv("DISPUTE_AGE_LATE_HOURS", late);
    expect(disputeAgeLimits()).toEqual({ warnHours, lateHours });
  });
});

describe("a split's amount", () => {
  it.each([
    ["45.50", 4550],
    ["45.5", 4550],
    ["45", 4500],
    ["$45.50", 4550],
    [" 45.50 ", 4550],
    ["12.345", 1235],
    ["12.344", 1234],
    ["12.3449", 1234],
    ["0.995", 100],
    ["99.999", 10000],
    ["0", 0],
    ["0.00", 0],
  ])("reads %j as %s cents", (typed, cents) => {
    expect(dollarsToCents(typed)).toBe(cents);
  });

  it.each(["", "-5", "-0.50", "abc", "4,550", "45.50.1", "1e3", "45 50", "$", ".50", "Infinity"])(
    "is no amount for %j",
    (typed) => {
      expect(dollarsToCents(typed)).toBeNull();
    },
  );

  it.each([
    ["0", "zero"],
    ["0.004", "zero"],
    ["100", "not_less"], // the payout itself: all of it would be a release
    ["100.01", "not_less"],
    ["250", "not_less"],
    ["-5", "format"],
    ["ten", "format"],
    ["0.01", null],
    ["99.99", null],
    ["45.50", null],
  ])("checks %j against a $100.00 payout: %s", (typed, problem) => {
    expect(amountError(dollarsToCents(typed), 10_000)).toBe(problem);
  });
});

describe("money", () => {
  it("is written from cents in the API's currency and the reader's locale", () => {
    expect(formatMoney(13_250, "usd", "en")).toBe("$132.50");
    expect(formatMoney(13_250, "usd", "es")).toMatch(/^132,50\s?US\$$/);
    expect(formatMoney(500, null, "en")).toBe("$5.00");
  });
});

describe("the refund's state", () => {
  it.each([
    ["no refund", null, null],
    ["Stripe gave the money back", refund({ status: "created", stripe_status: "succeeded" }), null],
    [
      "Stripe holds it, unfinished",
      refund({ status: "created", stripe_status: "pending" }),
      "pending",
    ],
    [
      "Stripe waits on an action",
      refund({ status: "created", stripe_status: "requires_action" }),
      "pending",
    ],
    ["Stripe failed it", refund({ status: "created", stripe_status: "failed" }), "failed"],
    ["Stripe canceled it", refund({ status: "created", stripe_status: "canceled" }), "failed"],
    [
      "an attempt is under way",
      refund({ status: "pending", stripe_status: null, stripe_refund_id: null }),
      "pending",
    ],
    [
      "the last call failed",
      refund({
        status: "failed",
        stripe_status: null,
        stripe_refund_id: null,
        last_error_code: "card_declined",
      }),
      "attempt_failed",
    ],
    // Stripe's word on the money wins over the last call's.
    [
      "a later call failed, the money is back",
      refund({ status: "failed", stripe_status: "succeeded" }),
      null,
    ],
    [
      "a status Stripe may add later",
      refund({ status: "created", stripe_status: "something_new" }),
      null,
    ],
  ] as const)("when %s is %s", (_case, value, state) => {
    expect(refundState(value)).toBe(state);
  });
});

describe("a photo's address", () => {
  it("is the panel's own route, never the storage's", () => {
    expect(photoHref(DISPUTE_ID, PHOTO_ID)).toBe(
      `/admin/disputes/${DISPUTE_ID}/photos/${PHOTO_ID}`,
    );
  });
});

describe("the note's limit", () => {
  it("is the API's (DisputeResolveIn.note in packages/shared/openapi.json)", () => {
    const file = fileURLToPath(
      new URL("../../../../../../../packages/shared/openapi.json", import.meta.url),
    );
    const openapi = JSON.parse(readFileSync(file, "utf8")) as {
      components: {
        schemas: Record<string, { properties: Record<string, { maxLength?: number }> }>;
      };
    };
    expect(NOTE_MAX_LENGTH).toBe(
      openapi.components.schemas.DisputeResolveIn.properties.note.maxLength,
    );
  });
});

describe("a resolve form", () => {
  it("sends a split's dollars as cents, never the dollars", () => {
    expect(
      resolveBodyOf(form({ decision: "partial", amount: "45.50", note: "Half done." })),
    ).toEqual({
      decision: "partial",
      pro_release_cents: 4550,
      note: "Half done.",
    });
    expect(resolveBodyOf(form({ decision: "partial", amount: "12.345", note: "n" }))).toMatchObject(
      {
        pro_release_cents: 1235,
      },
    );
  });

  it("sends no amount with a release or a refund, even when the form has one", () => {
    expect(
      resolveBodyOf(form({ decision: "release", amount: "45", note: " Done well. " })),
    ).toEqual({
      decision: "release",
      note: "Done well.",
    });
    expect(resolveBodyOf(form({ decision: "refund", note: "No-show." }))).toEqual({
      decision: "refund",
      note: "No-show.",
    });
  });

  it.each([
    [{ decision: "maybe", note: "n" }, "validation_error"],
    [{ note: "n" }, "validation_error"],
    [{ decision: "release", note: "   " }, "validation_error"],
    [{ decision: "release", note: "x".repeat(NOTE_MAX_LENGTH + 1) }, "validation_error"],
    [{ decision: "partial", amount: "0", note: "n" }, "invalid_split"],
    [{ decision: "partial", amount: "-5", note: "n" }, "invalid_split"],
    [{ decision: "partial", amount: "lots", note: "n" }, "invalid_split"],
    [{ decision: "partial", note: "n" }, "invalid_split"],
  ])("refuses %o as %s", (fields, error) => {
    expect(resolveBodyOf(form(fields as Record<string, string>))).toBe(error);
  });

  it("takes a note of exactly the limit", () => {
    const note = "x".repeat(NOTE_MAX_LENGTH);
    expect(resolveBodyOf(form({ decision: "release", note }))).toEqual({
      decision: "release",
      note,
    });
  });
});

describe("a failed resolve", () => {
  it.each([
    [403, "forbidden", "forbidden"],
    [404, "not_found", "not_found"],
    [409, "dispute_already_resolved", "dispute_already_resolved"],
    [409, "resolution_in_progress", "resolution_in_progress"],
    [409, "refund_already_attempted", "refund_already_attempted"],
    [409, "refund_pending", "refund_pending"],
    [409, "refund_failed", "refund_failed"],
    [409, "dispute_needs_review", "dispute_needs_review"],
    [409, "something_new", "unavailable"],
    [422, "invalid_split", "invalid_split"],
    [422, "validation_error", "validation_error"],
    [502, "payments_error", "payments_error"],
    [503, "payments_unavailable", "payments_unavailable"],
    [503, "not_configured", "not_configured"],
    [500, "internal", "unavailable"],
  ])("answering %s %s is %s", (status, code, error) => {
    expect(resolveErrorOf(new ApiError(status, code))).toBe(error);
  });

  it("is unconfirmed when the API never answered", () => {
    expect(resolveErrorOf(new TypeError("fetch failed"))).toBe("unconfirmed");
    expect(resolveErrorOf(new DOMException("timed out", "TimeoutError"))).toBe("unconfirmed");
  });

  it("has a message for every outcome, in both languages", async () => {
    for (const locale of ["en", "es"]) {
      const catalog = (await import(`@/i18n/locales/${locale}.json`)) as {
        admin: { disputes: { resolve: { errors: Record<string, string> } } };
      };
      expect(Object.keys(catalog.admin.disputes.resolve.errors).sort()).toEqual(
        [...RESOLVE_ERRORS].sort(),
      );
    }
  });
});
