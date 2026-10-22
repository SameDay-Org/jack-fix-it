/** Orderings across tabs and over time (#158 round 1): stale refreshes, short access tokens. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auth, FakeCookieJar, RedirectSignal, routeFetch, TOKENS, user } from "./test-helpers";

const { jar } = vi.hoisted(() => ({ jar: { current: null as unknown } }));

vi.mock("next/headers", () => ({ cookies: async () => jar.current }));
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
  REFRESHED_COOKIE,
  refreshStaffSession,
  requireStaff,
  SESSION_COOKIE,
  startSession,
} from "./session";

const fetchMock = vi.fn<typeof fetch>();
let cookies: FakeCookieJar;
const REFRESH_TTL = "604800";

beforeEach(() => {
  cookies = new FakeCookieJar();
  jar.current = cookies;
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("REFRESH_TOKEN_TTL_SECONDS", REFRESH_TTL);
  vi.stubEnv("APP_ENV", "production");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (signal) {
    if (signal instanceof RedirectSignal) return signal.url;
    throw signal;
  }
  throw new Error("expected a redirect");
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** What a browser does when time passes: cookies whose max-age has run out disappear. */
function expireAfter(seconds: number): void {
  for (const call of cookies.sets) {
    const maxAge = call.options.maxAge;
    if (
      typeof maxAge === "number" &&
      maxAge <= seconds &&
      cookies.get(call.name)?.value === call.value
    ) {
      cookies.values.delete(call.name);
    }
  }
}

const SIGNED_IN = { [ACCESS_COOKIE]: "at-1", [REFRESH_COOKIE]: "rt-1", [SESSION_COOKIE]: "sid-1" };

describe("the session marker (only login sets it)", () => {
  it("login sets it with the refresh cookie's attributes and lifetime", async () => {
    await startSession(auth("agent"));

    const marker = cookies.sets.find((call) => call.name === SESSION_COOKIE);
    expect(marker?.value).toMatch(/^[0-9a-f-]{36}$/);
    expect(marker?.options).toMatchObject({
      httpOnly: true,
      sameSite: "strict",
      path: "/admin",
      secure: true,
      maxAge: Number(REFRESH_TTL),
    });
  });

  it("a refresh never sets it", async () => {
    cookies.reset(SIGNED_IN);
    fetchMock.mockImplementation(
      routeFetch({ "/v1/auth/refresh": () => Response.json(auth("agent")) }),
    );

    expect(await refreshStaffSession()).toBe(PANEL_PATH);
    expect(cookies.sets.map((call) => call.name)).not.toContain(SESSION_COOKIE);
  });

  it("without it the tokens are not a session: no /me, the session ends", async () => {
    cookies.reset({ [ACCESS_COOKIE]: "at-1", [REFRESH_COOKIE]: "rt-1" });

    expect(await redirectOf(requireStaff)).toBe(END_PATH);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a refresh response held across a logout in another tab cannot restore the session", async () => {
    // Tab A's refresh reaches the API; its response is held. Tab B logs out. A's late
    // response then sets fresh tokens, as a browser applies it, after the logout.
    const started = deferred<void>();
    const held = deferred<Response>();
    cookies.reset(SIGNED_IN);
    fetchMock.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/auth/refresh") {
        started.resolve();
        return held.promise;
      }
      if (path === "/v1/auth/logout") return new Response(null, { status: 204 });
      if (path === "/v1/auth/me") return Response.json(user("agent"));
      throw new Error(`unexpected fetch ${path}`);
    });

    const refresh = refreshStaffSession();
    await started.promise;
    await endSession();
    expect(cookies.values.size).toBe(0);
    held.resolve(Response.json(auth("agent")));
    await refresh;

    // The stray tokens are not a session: the next render ends it, with no 200.
    expect(cookies.get(ACCESS_COOKIE)?.value).toBe(TOKENS.access_token);
    expect(await redirectOf(requireStaff)).toBe(END_PATH);
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).not.toContain("/v1/auth/me");
  });
});

describe("the refresh guard follows the access token's lifetime", () => {
  it("with a 30 s access token, at 31 s it refreshes instead of ending", async () => {
    cookies.reset(SIGNED_IN);
    fetchMock.mockImplementation(
      routeFetch({ "/v1/auth/refresh": () => Response.json({ ...auth("agent"), expires_in: 30 }) }),
    );
    await refreshStaffSession();

    const guard = cookies.sets.find((call) => call.name === REFRESHED_COOKIE);
    expect(guard?.options.maxAge).toBeLessThan(30);
    expireAfter(31);

    expect(cookies.get(ACCESS_COOKIE)).toBeUndefined();
    expect(cookies.get(REFRESH_COOKIE)).toBeDefined();
    expect(await redirectOf(requireStaff)).toBe(REFRESH_PATH);
  });

  it("a fresh token the API still refuses ends the session instead of looping", async () => {
    cookies.reset(SIGNED_IN);
    fetchMock.mockImplementation(
      routeFetch({
        "/v1/auth/refresh": () => Response.json({ ...auth("agent"), expires_in: 30 }),
        "/v1/auth/me": () => Response.json({ error: { code: "invalid_token" } }, { status: 401 }),
      }),
    );
    await refreshStaffSession();

    expect(await redirectOf(requireStaff)).toBe(END_PATH);
  });
});
