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

import { REQUEST_ID } from "../queue/queue-test-helpers";
import { ACCESS_TOKEN, me, requestsTo, signIn } from "../support/support-test-helpers";
import { claimRequest, releaseRequest } from "./actions";

const CLAIM = `/v1/admin/requests/${REQUEST_ID}/claim`;
const RELEASE = `/v1/admin/requests/${REQUEST_ID}/release`;
const REFUSED = { error: "unavailable", saved: false };
const REFRESHED = [`/admin/requests/${REQUEST_ID}`, "/admin/queue"];
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
      [CLAIM]: post,
      [RELEASE]: post,
    }),
  );
}

function paths(): string[] {
  return fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
}

function refreshed(): string[] {
  return revalidatePath.mock.calls.map(([path]) => path);
}

const ACTIONS = [
  ["claimRequest", CLAIM, claimRequest],
  ["releaseRequest", RELEASE, releaseRequest],
] as const;

describe.each(ACTIONS)("%s", (_, path, run) => {
  it("posts to the API with the staff token and no body, then refreshes the card and the queue", async () => {
    api(() => Response.json({ id: REQUEST_ID, assigned_agent: null }));

    const state = await run(REQUEST_ID);

    expect(state).toEqual({ error: null, saved: true });
    // The session is checked first, then the one POST.
    expect(paths()).toEqual(["/v1/auth/me", path]);
    const [request] = requestsTo(fetchMock.mock.calls, path);
    expect(request?.init?.method).toBe("POST");
    expect(request?.init?.body).toBeUndefined();
    expect(new Headers(request?.init?.headers).get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(refreshed()).toEqual(REFRESHED);
  });

  it.each(["not-a-uuid", "..", `${REQUEST_ID}/../../auth/logout`, ""])(
    "refuses the id %j before anything is asked",
    async (requestId) => {
      api(() => Response.json({}));

      expect(await run(requestId)).toEqual(REFUSED);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it.each([
    [409, "held"],
    [404, "not_found"],
  ] as const)(
    "reports that the request changed meanwhile (%i) and reads the card again",
    async (status, error) => {
      api(() => Response.json({ error: { code: "x", message: "x" } }, { status }));

      expect(await run(REQUEST_ID)).toEqual({ error, saved: false });
      // The card then shows who holds the request now.
      expect(refreshed()).toEqual(REFRESHED);
    },
  );

  it.each([
    [403, "forbidden"],
    [401, "unavailable"],
    [422, "unavailable"],
    [500, "unavailable"],
  ] as const)("reports a refusal of the API (%i) and refreshes nothing", async (status, error) => {
    api(() => Response.json({ error: { code: "x", message: "x" } }, { status }));

    expect(await run(REQUEST_ID)).toEqual({ error, saved: false });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reports a network failure", async () => {
    api(() => {
      throw new TypeError("fetch failed");
    });

    expect(await run(REQUEST_ID)).toEqual(REFUSED);
  });

  it.each(["customer", "none"] as const)(
    "changes nothing without a staff session (%s)",
    async (who) => {
      if (who === "none") cookies.reset({});
      api(() => Response.json({}), "customer");

      // To the login, never to a session route (Next would follow that one on the server).
      await expect(run(REQUEST_ID)).rejects.toMatchObject(new RedirectSignal("/admin/login"));

      expect(paths()).not.toContain(path);
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );
});
