import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCookieJar, RedirectSignal, routeFetch } from "@/lib/test-helpers";

const { jar, revalidatePath } = vi.hoisted(() => ({
  jar: { current: null as unknown },
  revalidatePath: vi.fn<(path: string) => void>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => jar.current,
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", async () => {
  const { RedirectSignal: Signal } = await import("@/lib/test-helpers");
  return {
    redirect: (url: string) => {
      throw new Signal(url);
    },
  };
});
vi.mock("next/cache", () => ({ revalidatePath }));

import { ACCESS_TOKEN, me, requestsTo, signIn } from "../support/support-test-helpers";
import { resolveDispute, type ResolveState } from "./actions";
import { DISPUTE_ID, JOB_ID } from "./disputes-test-helpers";

const RESOLVE = `/v1/admin/disputes/${DISPUTE_ID}/resolve`;
const START: ResolveState = { error: null, resolved: false };
const fetchMock = vi.fn<typeof fetch>();
let cookies: FakeCookieJar;

beforeEach(() => {
  cookies = new FakeCookieJar();
  jar.current = cookies;
  signIn(cookies);
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("REFRESH_TOKEN_TTL_SECONDS", "2592000");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  revalidatePath.mockReset();
});

const RESOLVED = {
  id: DISPUTE_ID,
  job_id: JOB_ID,
  status: "resolved",
  resolution: "partial_release",
  pro_release_cents: 4550,
  customer_refund_cents: 7220,
  resolved_at: "2026-11-18T12:00:00Z",
  job_status: "disputed",
  refund: null,
};

function api(post: () => Response, role: "agent" | "admin" = "admin"): void {
  fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => me(role), [RESOLVE]: post }));
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

function posts(): unknown[] {
  return requestsTo(fetchMock.mock.calls, RESOLVE).map(({ init }) =>
    JSON.parse(String(init?.body)),
  );
}

describe("resolving a dispute", () => {
  it("sends a split's amount in cents with the note, once, with the staff token", async () => {
    api(() => Response.json(RESOLVED));
    const state = await resolveDispute(
      DISPUTE_ID,
      START,
      form({ decision: "partial", amount: "45.50", note: "  Half the job was done.  " }),
    );
    expect(state).toEqual({ error: null, resolved: true });
    expect(posts()).toEqual([
      { decision: "partial", pro_release_cents: 4550, note: "Half the job was done." },
    ]);
    const [call] = requestsTo(fetchMock.mock.calls, RESOLVE);
    expect(new Headers(call?.init?.headers).get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/disputes/${DISPUTE_ID}`);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/disputes");
  });

  it.each(["release", "refund"])("sends a %s with its note and no amount", async (decision) => {
    api(() => Response.json(RESOLVED));
    await resolveDispute(DISPUTE_ID, START, form({ decision, amount: "45", note: "Why." }));
    expect(posts()).toEqual([{ decision, note: "Why." }]);
  });

  it.each([
    [{ decision: "partial", amount: "0", note: "n" }, "invalid_split"],
    [{ decision: "partial", amount: "1,000", note: "n" }, "invalid_split"],
    [{ decision: "release", note: " " }, "validation_error"],
    [{ decision: "everything", note: "n" }, "validation_error"],
  ])("sends nothing for %o", async (fields, error) => {
    api(() => Response.json(RESOLVED));
    expect(await resolveDispute(DISPUTE_ID, START, form(fields))).toEqual({
      error,
      resolved: false,
    });
    expect(posts()).toEqual([]);
  });

  it("sends nothing for an id that is not a UUID", async () => {
    api(() => Response.json(RESOLVED));
    const state = await resolveDispute("../pros", START, form({ decision: "release", note: "n" }));
    expect(state).toEqual({ error: "not_found", resolved: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [403, "forbidden", "forbidden", false],
    [404, "not_found", "not_found", true],
    [409, "dispute_already_resolved", "dispute_already_resolved", true],
    [409, "resolution_in_progress", "resolution_in_progress", true],
    [409, "refund_already_attempted", "refund_already_attempted", true],
    [409, "refund_pending", "refund_pending", true],
    [409, "refund_failed", "refund_failed", true],
    [409, "dispute_needs_review", "dispute_needs_review", true],
    [422, "invalid_split", "invalid_split", false],
    [422, "validation_error", "validation_error", false],
    [502, "payments_error", "payments_error", true],
    [503, "payments_unavailable", "payments_unavailable", true],
    [503, "not_configured", "not_configured", true],
  ])("maps %s %s to %s, reading the page again: %s", async (status, code, error, reread) => {
    api(() => Response.json({ error: { code, message: "The API's own words." } }, { status }));
    const state = await resolveDispute(DISPUTE_ID, START, form({ decision: "refund", note: "n" }));
    expect(state).toEqual({ error, resolved: false });
    expect(posts()).toHaveLength(1);
    expect(revalidatePath.mock.calls.length > 0).toBe(reread);
  });

  it("is unconfirmed when the API never answers: one call, no retry, the page read again", async () => {
    api(() => {
      throw new TypeError("fetch failed");
    });
    const state = await resolveDispute(DISPUTE_ID, START, form({ decision: "refund", note: "n" }));
    expect(state).toEqual({ error: "unconfirmed", resolved: false });
    expect(requestsTo(fetchMock.mock.calls, RESOLVE)).toHaveLength(1);
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/disputes/${DISPUTE_ID}`);
  });

  it("sends a visitor without a staff session to the login, before anything is sent", async () => {
    cookies.reset({});
    api(() => Response.json(RESOLVED));
    await expect(
      resolveDispute(DISPUTE_ID, START, form({ decision: "release", note: "n" })),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(posts()).toEqual([]);
  });
});
