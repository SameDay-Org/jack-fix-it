import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCookieJar, RedirectSignal, routeFetch } from "@/lib/test-helpers";

const { jar, revalidatePath } = vi.hoisted(() => ({
  jar: { current: null as unknown },
  revalidatePath: vi.fn<(path: string) => void>(),
}));

vi.mock("next/headers", () => ({ cookies: async () => jar.current }));
vi.mock("next/navigation", async () => {
  const { RedirectSignal: Signal } = await import("@/lib/test-helpers");
  return {
    redirect: (url: string) => {
      throw new Signal(url);
    },
  };
});
vi.mock("next/cache", () => ({ revalidatePath }));

import { REQUEST_ID } from "../queue/queue-test-helpers";
import { ACCESS_TOKEN, me, requestsTo, signIn } from "../support/support-test-helpers";
import {
  addNote,
  classifyRequest,
  completeFollowup,
  markContacted,
  scheduleFollowup,
} from "./actions";
import type { OpsState } from "./ops";

const BASE = `/v1/admin/requests/${REQUEST_ID}`;
const FOLLOWUP_ID = "5d4c3b2a-1111-4222-8333-944455556666";
const CATEGORY_ID = "8e7f6a5b-1111-4222-8333-944455556666";
const STAFF_ID = "9a8b7c6d-1111-4222-8333-944455556666";
const PATHS = {
  notes: `${BASE}/notes`,
  contacted: `${BASE}/contacted`,
  classify: `${BASE}/classify`,
  followups: `${BASE}/followups`,
  done: `${BASE}/followups/${FOLLOWUP_ID}/done`,
};
const START: OpsState = { error: null, saved: false };
// 2026-11-19 at 10:00 in New York.
const NOW = Date.parse("2026-11-19T15:00:00Z");
const fetchMock = vi.fn<typeof fetch>();
let cookies: FakeCookieJar;

beforeEach(() => {
  cookies = new FakeCookieJar();
  jar.current = cookies;
  signIn(cookies);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("REFRESH_TOKEN_TTL_SECONDS", "2592000");
  vi.stubEnv("BUSINESS_TIME_ZONE", "America/New_York");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  revalidatePath.mockReset();
});

function api(answer: () => Response, role: "agent" | "admin" = "agent"): void {
  fetchMock.mockImplementation(
    routeFetch({
      "/v1/auth/me": () => me(role),
      ...Object.fromEntries(Object.values(PATHS).map((path) => [path, answer])),
    }),
  );
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

/** The bodies POSTed to a path, parsed. */
function sent(path: string): unknown[] {
  return requestsTo(fetchMock.mock.calls, path).map(({ init }) =>
    init?.body === undefined ? undefined : JSON.parse(String(init.body)),
  );
}

const ok = () => Response.json({});

describe("adding a note", () => {
  it("sends the note as typed, trimmed, once, with the staff token", async () => {
    api(ok);
    const body = '  Called twice.\n<script>alert("x")</script>  ';
    expect(await addNote(REQUEST_ID, START, form({ body }))).toEqual({ error: null, saved: true });
    expect(sent(PATHS.notes)).toEqual([{ body: body.trim() }]);
    const [call] = requestsTo(fetchMock.mock.calls, PATHS.notes);
    expect(new Headers(call?.init?.headers).get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/requests/${REQUEST_ID}`);
  });

  it.each([
    ["", "note_empty"],
    ["   \n ", "note_empty"],
    ["x".repeat(2001), "note_too_long"],
  ])("sends nothing for %j", async (body, error) => {
    api(ok);
    expect(await addNote(REQUEST_ID, START, form({ body }))).toEqual({ error, saved: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("takes a note of exactly 2000 characters", async () => {
    api(ok);
    await addNote(REQUEST_ID, START, form({ body: "x".repeat(2000) }));
    expect(sent(PATHS.notes)).toHaveLength(1);
  });
});

describe("marking contacted, classifying, marking done", () => {
  it("sends one call each, with nothing but the ids and the category", async () => {
    api(ok);
    expect(await markContacted(REQUEST_ID)).toEqual({ error: null, saved: true });
    expect(await classifyRequest(REQUEST_ID, START, form({ category_id: CATEGORY_ID }))).toEqual({
      error: null,
      saved: true,
    });
    expect(await completeFollowup(REQUEST_ID, FOLLOWUP_ID)).toEqual({ error: null, saved: true });
    expect(sent(PATHS.contacted)).toEqual([undefined]);
    expect(sent(PATHS.classify)).toEqual([{ category_id: CATEGORY_ID }]);
    expect(sent(PATHS.done)).toEqual([undefined]);
  });

  it("sends nothing for ids that are not UUIDs", async () => {
    api(ok);
    await markContacted("../pros");
    await classifyRequest(REQUEST_ID, START, form({ category_id: "plumbing" }));
    await completeFollowup(REQUEST_ID, "1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("scheduling a follow-up", () => {
  it("sends the day and time typed in the business time zone as an instant, with the note", async () => {
    api(ok);
    const state = await scheduleFollowup(
      REQUEST_ID,
      START,
      form({ day: "2026-11-20", time: "09:30", note: " Call back about the quote. " }),
    );
    expect(state).toEqual({ error: null, saved: true });
    // 09:30 in New York on 2026-11-20 (EST) is 14:30 UTC.
    expect(sent(PATHS.followups)).toEqual([
      { due_at: "2026-11-20T14:30:00.000Z", note: "Call back about the quote." },
    ]);
  });

  it("passes the assignee an admin's form names (the API checks the role)", async () => {
    api(ok, "admin");
    await scheduleFollowup(
      REQUEST_ID,
      START,
      form({ day: "2026-11-20", time: "09:30", note: "n", assigned_to: STAFF_ID }),
    );
    expect(sent(PATHS.followups)).toEqual([
      { due_at: "2026-11-20T14:30:00.000Z", note: "n", assigned_to: STAFF_ID },
    ]);
  });

  it.each([
    [{ day: "2026-11-19", time: "09:00", note: "n" }, "due_past"],
    [{ day: "2026-12-20", time: "10:01", note: "n" }, "due_too_far"],
    [{ day: "", time: "10:00", note: "n" }, "due_invalid"],
    [{ day: "2026-11-20", time: "25:00", note: "n" }, "due_invalid"],
    [{ day: "2026-11-20", time: "10:00", note: " " }, "note_empty"],
    [{ day: "2026-11-20", time: "10:00", note: "x".repeat(501) }, "note_too_long"],
    [{ day: "2026-11-20", time: "10:00", note: "n", assigned_to: "me" }, "validation_error"],
  ])("sends nothing for %o", async (fields, error) => {
    api(ok);
    expect(await scheduleFollowup(REQUEST_ID, START, form(fields))).toEqual({
      error,
      saved: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("takes the API's window from OPS_FOLLOWUP_MAX_DAYS", async () => {
    vi.stubEnv("OPS_FOLLOWUP_MAX_DAYS", "2");
    api(ok);
    const state = await scheduleFollowup(
      REQUEST_ID,
      START,
      form({ day: "2026-11-25", time: "10:00", note: "n" }),
    );
    expect(state.error).toBe("due_too_far");
  });
});

describe("a refused action", () => {
  it.each([
    [409, "request_held", "request_held", true],
    [409, "request_not_classifiable", "request_not_classifiable", true],
    [422, "category_inactive", "category_inactive", false],
    [422, "followup_due_out_of_range", "followup_due_out_of_range", false],
    [422, "assignee_not_staff", "assignee_not_staff", false],
    [422, "validation_error", "validation_error", false],
    [404, "followup_not_found", "followup_not_found", true],
    [404, "request_not_found", "request_not_found", true],
    [403, "forbidden", "forbidden", true],
    [429, "rate_limited", "rate_limited", false],
    [500, "internal", "unavailable", true],
  ])("maps %s %s to %s, reading the card again: %s", async (status, code, error, reread) => {
    api(() => Response.json({ error: { code, message: "The API's own words." } }, { status }));
    expect(await addNote(REQUEST_ID, START, form({ body: "n" }))).toEqual({ error, saved: false });
    expect(sent(PATHS.notes)).toHaveLength(1);
    expect(revalidatePath.mock.calls.length > 0).toBe(reread);
  });

  it("maps a Mark done refused to an account revoked or demoted since to forbidden, the card read again (#499 round 1)", async () => {
    // Even a replay of a done follow-up: the API checks the actor first.
    api(() => Response.json({ error: { code: "forbidden", message: "raw" } }, { status: 403 }));
    expect(await completeFollowup(REQUEST_ID, FOLLOWUP_ID)).toEqual({
      error: "forbidden",
      saved: false,
    });
    expect(sent(PATHS.done)).toHaveLength(1);
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/requests/${REQUEST_ID}`);
  });

  it("is unconfirmed when the API never answers: one call, never sent again, the card read again", async () => {
    api(() => {
      throw new TypeError("fetch failed");
    });
    expect(await addNote(REQUEST_ID, START, form({ body: "n" }))).toEqual({
      error: "unconfirmed",
      saved: false,
    });
    expect(sent(PATHS.notes)).toHaveLength(1);
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/requests/${REQUEST_ID}`);
  });

  it("sends a visitor without a staff session to the login, before anything is sent", async () => {
    cookies.reset({});
    api(ok);
    await expect(addNote(REQUEST_ID, START, form({ body: "n" }))).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(sent(PATHS.notes)).toEqual([]);
  });
});
