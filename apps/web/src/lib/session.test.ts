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
  LOGIN_PATH,
  PANEL_PATH,
  REFRESH_COOKIE,
  REFRESH_PATH,
  REFRESHED_COOKIE,
  refreshStaffSession,
  SESSION_COOKIE,
  requireStaff,
  setSession,
} from "./session";

const fetchMock = vi.fn<typeof fetch>();
let cookies: FakeCookieJar;
const REFRESH_TTL = "604800"; // not the API default, so the test proves it comes from env

beforeEach(() => {
  cookies = new FakeCookieJar();
  jar.current = cookies;
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("REFRESH_TOKEN_TTL_SECONDS", REFRESH_TTL);
  vi.stubEnv("APP_ENV", "development");
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

function calledPaths(): string[] {
  return fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
}

describe("session cookies", () => {
  it.each([
    ["development", false],
    ["test", false],
    ["staging", true],
    ["production", true],
  ])("cookies_are_httpOnly_strict_and_secure_when_deployed (%s)", async (env, secure) => {
    vi.stubEnv("APP_ENV", env);

    await setSession(auth("agent"));

    const byName = Object.fromEntries(cookies.sets.map((call) => [call.name, call]));
    for (const name of [ACCESS_COOKIE, REFRESH_COOKIE]) {
      expect(byName[name]!.options).toMatchObject({
        httpOnly: true,
        sameSite: "strict",
        path: "/admin",
        secure,
      });
    }
    expect(byName[ACCESS_COOKIE]!.options.maxAge).toBe(TOKENS.expires_in);
    expect(byName[REFRESH_COOKIE]!.options.maxAge).toBe(Number(REFRESH_TTL));
  });

  it("refuses to set a refresh cookie without the TTL setting", async () => {
    vi.stubEnv("REFRESH_TOKEN_TTL_SECONDS", "");

    await expect(setSession(auth("agent"))).rejects.toThrow("REFRESH_TOKEN_TTL_SECONDS");
  });
});

describe("requireStaff", () => {
  it("returns the staff member checked against /me with the access token", async () => {
    cookies.reset({ [SESSION_COOKIE]: "sid-1", [ACCESS_COOKIE]: "at-1", [REFRESH_COOKIE]: "rt-1" });
    fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => Response.json(user("admin")) }));

    const staff = await requireStaff();

    expect(staff.role).toBe("admin");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer at-1");
  });

  it("requireStaff_refreshes_once_then_redirects", async () => {
    // 1. The access token is refused: off to the one-time refresh.
    cookies.reset({ [SESSION_COOKIE]: "sid-1", [ACCESS_COOKIE]: "at-old", [REFRESH_COOKIE]: "rt-old" });
    fetchMock.mockImplementation(
      routeFetch({
        "/v1/auth/me": () => Response.json({ error: { code: "invalid_token" } }, { status: 401 }),
        "/v1/auth/refresh": () => Response.json(auth("agent")),
      }),
    );
    expect(await redirectOf(requireStaff)).toBe(REFRESH_PATH);

    // 2. The refresh route rotates both cookies and returns to the panel.
    expect(await refreshStaffSession()).toBe(PANEL_PATH);
    expect(cookies.get(ACCESS_COOKIE)?.value).toBe(TOKENS.access_token);

    // 3. The API still refuses the new token: no second refresh, the session ends.
    expect(await redirectOf(requireStaff)).toBe(END_PATH);
    expect(calledPaths().filter((path) => path === "/v1/auth/refresh")).toHaveLength(1);
  });

  it("goes to the session end without a refresh token", async () => {
    cookies.reset({});

    expect(await redirectOf(requireStaff)).toBe(END_PATH);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["customer", "pro"] as const)(
    "requireStaff_redirects_non_staff_role (%s)",
    async (role) => {
      cookies.reset({ [SESSION_COOKIE]: "sid-1", [ACCESS_COOKIE]: "at-1", [REFRESH_COOKIE]: "rt-1" });
      fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => Response.json(user(role)) }));

      expect(await redirectOf(requireStaff)).toBe(END_PATH);
    },
  );
});

describe("refreshStaffSession", () => {
  it("refresh_rotates_both_cookies", async () => {
    cookies.reset({ [SESSION_COOKIE]: "sid-1", [ACCESS_COOKIE]: "at-old", [REFRESH_COOKIE]: "rt-old" });
    fetchMock.mockImplementation(
      routeFetch({ "/v1/auth/refresh": () => Response.json(auth("agent")) }),
    );

    expect(await refreshStaffSession()).toBe(PANEL_PATH);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: "rt-old" });
    expect(cookies.get(ACCESS_COOKIE)?.value).toBe(TOKENS.access_token);
    expect(cookies.get(REFRESH_COOKIE)?.value).toBe(TOKENS.refresh_token);
    expect(cookies.get(REFRESHED_COOKIE)?.value).toBe("1");
  });

  it("clears the session and goes to the login when the refresh is refused", async () => {
    cookies.reset({ [SESSION_COOKIE]: "sid-1", [ACCESS_COOKIE]: "at-old", [REFRESH_COOKIE]: "rt-old" });
    fetchMock.mockImplementation(
      routeFetch({
        "/v1/auth/refresh": () =>
          Response.json({ error: { code: "invalid_refresh_token" } }, { status: 401 }),
      }),
    );

    expect(await refreshStaffSession()).toBe(LOGIN_PATH);
    expect(cookies.values.size).toBe(0);
  });

  it("revokes and clears when the refreshed account is no longer staff", async () => {
    cookies.reset({ [SESSION_COOKIE]: "sid-1", [REFRESH_COOKIE]: "rt-old" });
    fetchMock.mockImplementation(
      routeFetch({
        "/v1/auth/refresh": () => Response.json(auth("customer")),
        "/v1/auth/logout": () => new Response(null, { status: 204 }),
      }),
    );

    expect(await refreshStaffSession()).toBe(LOGIN_PATH);
    expect(calledPaths()).toEqual(["/v1/auth/refresh", "/v1/auth/logout"]);
    expect(cookies.values.size).toBe(0);
    expect(cookies.sets.filter((call) => call.name === ACCESS_COOKIE)).toEqual([]);
  });
});

describe("endSession", () => {
  it.each([
    ["the API is down", () => Promise.reject(new TypeError("fetch failed"))],
    ["the API errors", () => Promise.resolve(new Response(null, { status: 500 }))],
    ["the API answers", () => Promise.resolve(new Response(null, { status: 204 }))],
  ])("logout_clears_cookies_even_if_api_fails (%s)", async (_, answer) => {
    cookies.reset({ [SESSION_COOKIE]: "sid-1", [ACCESS_COOKIE]: "at-1", [REFRESH_COOKIE]: "rt-1", [REFRESHED_COOKIE]: "1" });
    fetchMock.mockImplementation(answer);

    await endSession();

    expect(cookies.values.size).toBe(0);
    expect(cookies.deletes.every((call) => call.path === "/admin")).toBe(true);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: "rt-1" });
  });
});
