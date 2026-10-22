/**
 * The tokens are bound to the login that issued them (#158 round 2). Each request gets its own
 * cookie jar, filled from a simulated browser and applied back to it when its response
 * arrives, so held responses land in the order a browser would apply them.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auth, FakeCookieJar, RedirectSignal, user } from "./test-helpers";

const { context } = vi.hoisted(() => ({
  context: { store: null as null | { getStore: () => unknown } },
}));

vi.mock("next/headers", () => ({ cookies: async () => context.store?.getStore() }));
vi.mock("next/navigation", async () => {
  const { RedirectSignal: Signal } = await import("./test-helpers");
  return {
    redirect: (url: string) => {
      throw new Signal(url);
    },
  };
});

import {
  ACCESS_COOKIE,
  END_PATH,
  endSession,
  PANEL_PATH,
  REFRESH_COOKIE,
  REFRESH_PATH,
  refreshStaffSession,
  requireStaff,
  SESSION_COOKIE,
  startSession,
} from "./session";

const jars = new AsyncLocalStorage<FakeCookieJar>();
context.store = jars;
const fetchMock = vi.fn<typeof fetch>();
const browser = new Map<string, string>();
const accountA = user("agent", { id: "11111111-1111-4111-8111-111111111111", email: "a@x.com" });
const accountB = user("admin", { id: "22222222-2222-4222-8222-222222222222", email: "b@x.com" });
const tokensA = {
  ...auth("agent"),
  user: accountA,
  access_token: "access-A",
  refresh_token: "refresh-A",
};
const tokensB = {
  ...auth("admin"),
  user: accountB,
  access_token: "access-B",
  refresh_token: "refresh-B",
};

/** One request: a jar with the browser's cookies, whose writes reach the browser at the end. */
async function request<T>(run: () => Promise<T>): Promise<T> {
  const jar = new FakeCookieJar();
  jar.reset(Object.fromEntries(browser));
  try {
    return await jars.run(jar, run);
  } finally {
    for (const call of jar.deletes) browser.delete(call.name);
    for (const call of jar.sets) browser.set(call.name, call.value);
  }
}

/** Who the panel serves now: a user id, or where it redirects. */
async function panel(): Promise<string> {
  try {
    return (await request(requireStaff)).id;
  } catch (signal) {
    if (signal instanceof RedirectSignal) return signal.url;
    throw signal;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The API double: /me answers for whichever raw access token it gets; refresh can be held. */
function api(refresh: () => Promise<Response> = async () => Response.json(tokensA)): void {
  fetchMock.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const bearer = new Headers(init?.headers).get("Authorization");
    if (path === "/v1/auth/logout") return new Response(null, { status: 204 });
    if (path === "/v1/auth/refresh") return refresh();
    if (path === "/v1/auth/me" && bearer === "Bearer access-A") return Response.json(accountA);
    if (path === "/v1/auth/me" && bearer === "Bearer access-B") return Response.json(accountB);
    if (path === "/v1/auth/me")
      return Response.json({ error: { code: "invalid_token" } }, { status: 401 });
    throw new Error(`unexpected fetch ${path} (${bearer ?? "no bearer"})`);
  });
}

function sentBearers(): string[] {
  return fetchMock.mock.calls.map(
    ([, init]) => new Headers(init?.headers).get("Authorization") ?? "",
  );
}

beforeEach(() => {
  browser.clear();
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("REFRESH_TOKEN_TTL_SECONDS", "2592000");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("tokens are bound to their login", () => {
  it("a refresh of A held across A's logout and B's login never serves A", async () => {
    const started = deferred<void>();
    const held = deferred<Response>();
    api(async () => {
      started.resolve();
      return held.promise;
    });
    await request(() => startSession(tokensA));
    const sidA = browser.get(SESSION_COOKIE);

    const refresh = request(refreshStaffSession); // tab A, still carrying A's cookies
    await started.promise;
    await request(endSession); // A logs out
    await request(() => startSession(tokensB)); // B logs in
    expect(browser.get(SESSION_COOKIE)).not.toBe(sidA);
    expect(await panel()).toBe(accountB.id);
    held.resolve(Response.json(tokensA)); // A's response lands last
    await refresh;

    expect(await panel()).toBe(END_PATH);
    expect(sentBearers()).not.toContain("Bearer access-A");
  });

  it("an access cookie from another login ends the session without asking the API", async () => {
    api();
    await request(() => startSession(tokensB));
    const sidB = browser.get(SESSION_COOKIE)!.split(".")[0]!;
    browser.set(ACCESS_COOKIE, `${crypto.randomUUID()}.access-A`);

    expect(await panel()).toBe(END_PATH);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(browser.get(REFRESH_COOKIE)?.startsWith(`${sidB}.`)).toBe(true); // untouched so far
  });

  it("a refresh cookie from another login is never refreshed", async () => {
    api();
    await request(() => startSession(tokensB));
    browser.delete(ACCESS_COOKIE); // expired
    browser.set(REFRESH_COOKIE, `${crypto.randomUUID()}.refresh-A`);

    expect(await panel()).toBe(END_PATH);
    expect(await request(refreshStaffSession)).toBe(END_PATH);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("/me answering another user than the login's ends the session", async () => {
    api();
    await request(() => startSession(tokensB));
    const sid = browser.get(SESSION_COOKIE)!.split(".")[0]!;
    browser.set(ACCESS_COOKIE, `${sid}.access-A`); // same login prefix, someone else's token

    expect(await panel()).toBe(END_PATH);
  });

  it("the API only ever sees raw tokens", async () => {
    api();
    await request(() => startSession(tokensA));
    browser.delete(ACCESS_COOKIE);

    expect(await request(refreshStaffSession)).toBe(PANEL_PATH);
    expect(await panel()).toBe(accountA.id);
    await request(endSession);

    const bodies = fetchMock.mock.calls.map(([, init]) => String(init?.body ?? ""));
    expect(bodies.filter((body) => body.includes("refresh_token"))).toEqual([
      JSON.stringify({ refresh_token: "refresh-A" }),
      JSON.stringify({ refresh_token: "refresh-A" }),
    ]);
    expect(sentBearers().filter(Boolean)).toEqual(["Bearer access-A"]);
  });

  it("login, then several refreshes, keeps serving the same user", async () => {
    api();
    await request(() => startSession(tokensA));
    const marker = browser.get(SESSION_COOKIE);

    for (let round = 0; round < 3; round++) {
      browser.delete(ACCESS_COOKIE); // the access token expired
      browser.delete("jfi_rf"); // and so did the loop guard, which lives slightly less
      expect(await panel()).toBe(REFRESH_PATH);
      expect(await request(refreshStaffSession)).toBe(PANEL_PATH);
      expect(await panel()).toBe(accountA.id);
    }
    expect(browser.get(SESSION_COOKIE)).toBe(marker); // a refresh never rewrites it
  });
});
