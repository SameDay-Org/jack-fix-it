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
import { decidePro, reviewDocument, type ReviewState } from "./actions";
import { DOCUMENT_ID, PRO_ID } from "./pros-test-helpers";

const REVIEW = `/v1/admin/pros/${PRO_ID}/documents/${DOCUMENT_ID}/review`;
const DECISION = `/v1/admin/pros/${PRO_ID}/decision`;
const START: ReviewState = { error: null, saved: false };
const REFUSED = { error: "unavailable", saved: false };
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

function api(post: () => Response, role: "agent" | "admin" | "customer" = "agent"): void {
  fetchMock.mockImplementation(
    routeFetch({
      "/v1/auth/me": () => me(role),
      "/v1/auth/logout": () => new Response(null, { status: 204 }),
      [REVIEW]: post,
      [DECISION]: post,
    }),
  );
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

function refuse(status: number, code: string): Response {
  return Response.json({ error: { code, message: "x" } }, { status });
}

function paths(): string[] {
  return fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
}

function sent(path: string): { body: unknown; authorization: string | null; method?: string } {
  const [request] = requestsTo(fetchMock.mock.calls, path);
  return {
    body: JSON.parse(String(request?.init?.body)),
    authorization: new Headers(request?.init?.headers).get("Authorization"),
    method: request?.init?.method,
  };
}

const ACTIONS = [
  ["reviewDocument", REVIEW, (data: FormData) => reviewDocument(PRO_ID, DOCUMENT_ID, START, data)],
  ["decidePro", DECISION, (data: FormData) => decidePro(PRO_ID, START, data)],
] as const;

describe.each(ACTIONS)("%s", (_, path, run) => {
  it("sends an approval through the API with the staff token", async () => {
    api(() => Response.json({}));

    const state = await run(form({ decision: "approved", reason: "ignored with an approval" }));

    expect(state).toEqual({ error: null, saved: true });
    // The session is checked first, then the one POST.
    expect(paths()).toEqual(["/v1/auth/me", path]);
    expect(sent(path)).toEqual({
      body: { decision: "approved" },
      authorization: `Bearer ${ACCESS_TOKEN}`,
      method: "POST",
    });
    expect(revalidatePath.mock.calls.map(([revalidated]) => revalidated)).toEqual([
      `/admin/pros/${PRO_ID}`,
      "/admin/pros",
    ]);
  });

  it("sends a rejection with its reason, trimmed", async () => {
    api(() => Response.json({}));

    const state = await run(form({ decision: "rejected", reason: "  The photo is blurry.\n" }));

    expect(state).toEqual({ error: null, saved: true });
    expect(sent(path).body).toEqual({ decision: "rejected", reason: "The photo is blurry." });
  });

  it.each([
    ["no reason", { decision: "rejected" }],
    ["a blank reason", { decision: "rejected", reason: " \n " }],
    ["a reason over the limit", { decision: "rejected", reason: "x".repeat(501) }],
  ])("asks for a reason before anything is sent (%s)", async (_, fields) => {
    api(() => Response.json({}));

    expect(await run(form(fields))).toEqual({ error: "reason_required", saved: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("takes the longest reason", async () => {
    api(() => Response.json({}));

    const state = await run(form({ decision: "rejected", reason: "x".repeat(500) }));

    expect(state).toEqual({ error: null, saved: true });
  });

  it.each([
    ["an unknown decision", { decision: "pending" }],
    ["no decision", { reason: "Why" }],
  ])("refuses %s before anything is asked", async (_, fields) => {
    api(() => Response.json({}));

    expect(await run(form(fields))).toEqual(REFUSED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [403, "forbidden", "forbidden"],
    [422, "validation_error", "unavailable"],
    [401, "invalid_token", "unavailable"],
    [500, "internal_error", "unavailable"],
  ] as const)(
    "reports a refusal of the API (%i %s) and refreshes nothing",
    async (status, code, error) => {
      api(() => refuse(status, code));

      expect(await run(form({ decision: "approved" }))).toEqual({ error, saved: false });
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it.each([
    [404, "pro_not_found", "not_found"],
    [409, "document_not_pending", "already_reviewed"],
    [422, "pro_not_approvable", "not_approvable"],
  ] as const)(
    "reports a refusal that means the page is out of date (%i %s) and reads the page again",
    async (status, code, error) => {
      api(() => refuse(status, code));

      expect(await run(form({ decision: "approved" }))).toEqual({ error, saved: false });
      // The page then lists what the message points at: the blockers, the document's status.
      expect(revalidatePath.mock.calls.map(([revalidated]) => revalidated)).toEqual([
        `/admin/pros/${PRO_ID}`,
        "/admin/pros",
      ]);
    },
  );

  it("reports a network failure", async () => {
    api(() => {
      throw new TypeError("fetch failed");
    });

    expect(await run(form({ decision: "approved" }))).toEqual(REFUSED);
  });

  it.each(["customer", "none"] as const)(
    "changes nothing without a staff session (%s)",
    async (who) => {
      if (who === "none") cookies.reset({});
      api(() => Response.json({}), "customer");

      // To the login, never to a session route (Next would follow that one on the server).
      await expect(run(form({ decision: "approved" }))).rejects.toMatchObject(
        new RedirectSignal("/admin/login"),
      );

      expect(paths()).not.toContain(path);
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );
});

describe("ids", () => {
  it.each([
    ["a pro id that is not a UUID", "not-a-uuid", DOCUMENT_ID],
    ["a pro id that walks the path", "..", DOCUMENT_ID],
    ["a document id that is not a UUID", PRO_ID, "not-a-uuid"],
    ["a document id with a path in it", PRO_ID, `${DOCUMENT_ID}/../../decision`],
  ])("reviewDocument refuses %s before anything is asked", async (_, proId, documentId) => {
    api(() => Response.json({}));

    const state = await reviewDocument(proId, documentId, START, form({ decision: "approved" }));

    expect(state).toEqual(REFUSED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["not-a-uuid", "..", `${PRO_ID}/../../auth/logout`])(
    "decidePro refuses the id %s before anything is asked",
    async (proId) => {
      api(() => Response.json({}));

      expect(await decidePro(proId, START, form({ decision: "approved" }))).toEqual(REFUSED);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
