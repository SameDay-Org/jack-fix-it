import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  auth,
  bound,
  FakeCookieJar,
  MARKER,
  RedirectSignal,
  routeFetch,
  SID,
  TOKENS,
  user,
} from "./test-helpers";

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
  staffActionAuth,
  staffAuth,
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

    await setSession(auth("agent"), SID);

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

    await expect(setSession(auth("agent"), SID)).rejects.toThrow("REFRESH_TOKEN_TTL_SECONDS");
  });
});

describe("requireStaff", () => {
  it("returns the staff member checked against /me with the access token", async () => {
    cookies.reset({
      [SESSION_COOKIE]: MARKER,
      [ACCESS_COOKIE]: bound("at-1"),
      [REFRESH_COOKIE]: bound("rt-1"),
    });
    fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => Response.json(user("admin")) }));

    const staff = await requireStaff();

    expect(staff.role).toBe("admin");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer at-1");
  });

  it("requireStaff_refreshes_once_then_redirects", async () => {
    // 1. The access token is refused: off to the one-time refresh.
    cookies.reset({
      [SESSION_COOKIE]: MARKER,
      [ACCESS_COOKIE]: bound("at-old"),
      [REFRESH_COOKIE]: bound("rt-old"),
    });
    fetchMock.mockImplementation(
      routeFetch({
        "/v1/auth/me": () => Response.json({ error: { code: "invalid_token" } }, { status: 401 }),
        "/v1/auth/refresh": () => Response.json(auth("agent")),
      }),
    );
    expect(await redirectOf(requireStaff)).toBe(REFRESH_PATH);

    // 2. The refresh route rotates both cookies and returns to the panel.
    expect(await refreshStaffSession()).toBe(PANEL_PATH);
    expect(cookies.get(ACCESS_COOKIE)?.value).toBe(bound(TOKENS.access_token));

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
      cookies.reset({
        [SESSION_COOKIE]: MARKER,
        [ACCESS_COOKIE]: bound("at-1"),
        [REFRESH_COOKIE]: bound("rt-1"),
      });
      fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => Response.json(user(role)) }));

      expect(await redirectOf(requireStaff)).toBe(END_PATH);
    },
  );
});

describe("staffAuth", () => {
  it("gives the login's access token as a bearer header once /me accepted it", async () => {
    cookies.reset({
      [SESSION_COOKIE]: MARKER,
      [ACCESS_COOKIE]: bound("at-1"),
      [REFRESH_COOKIE]: bound("rt-1"),
    });
    fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => Response.json(user("agent")) }));

    const init = await staffAuth();

    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer at-1");
    expect(init.cache).toBe("no-store");
    expect(calledPaths()).toEqual(["/v1/auth/me"]);
  });

  it.each(["customer", "pro"] as const)("gives no header to a %s account", async (role) => {
    cookies.reset({ [SESSION_COOKIE]: MARKER, [ACCESS_COOKIE]: bound("at-1") });
    fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => Response.json(user(role)) }));

    expect(await redirectOf(staffAuth)).toBe(END_PATH);
  });

  it("gives no header without a session", async () => {
    cookies.reset({});

    expect(await redirectOf(staffAuth)).toBe(END_PATH);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("staffActionAuth", () => {
  const unauthorized = () => Response.json({ error: { code: "invalid_token" } }, { status: 401 });

  function bearerOf(init: RequestInit): string | null {
    return new Headers(init.headers).get("Authorization");
  }

  /** Each `/me` answers for the token it was asked with. */
  function meByToken(answers: Record<string, () => Response>) {
    return () => {
      const [, init] = fetchMock.mock.calls.at(-1)!;
      const token = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ?? "";
      return (answers[token] ?? unauthorized)();
    };
  }

  it("gives the bearer of a token /me accepts, and writes no cookie", async () => {
    cookies.reset({
      [SESSION_COOKIE]: MARKER,
      [ACCESS_COOKIE]: bound("at-1"),
      [REFRESH_COOKIE]: bound("rt-1"),
    });
    fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => Response.json(user("agent")) }));

    expect(bearerOf(await staffActionAuth())).toBe("Bearer at-1");
    expect(calledPaths()).toEqual(["/v1/auth/me"]);
    expect(cookies.sets).toEqual([]);
  });

  it.each([
    ["expired (the cookie is gone)", {}, ["/v1/auth/refresh", "/v1/auth/me"]],
    [
      "refused by the API",
      { [ACCESS_COOKIE]: bound("at-old") },
      ["/v1/auth/me", "/v1/auth/refresh", "/v1/auth/me"],
    ],
  ])("renews in place an access token that is %s", async (_, access, paths) => {
    cookies.reset({ [SESSION_COOKIE]: MARKER, [REFRESH_COOKIE]: bound("rt-old"), ...access });
    fetchMock.mockImplementation(
      routeFetch({
        "/v1/auth/me": meByToken({ [TOKENS.access_token]: () => Response.json(user("agent")) }),
        "/v1/auth/refresh": () => Response.json(auth("agent")),
      }),
    );

    const init = await staffActionAuth();

    // One refresh, then the renewed token checked like any other: never a session route.
    expect(bearerOf(init)).toBe(`Bearer ${TOKENS.access_token}`);
    expect(calledPaths()).toEqual(paths);
    const [, refresh] = fetchMock.mock.calls.find(
      ([input]) => new URL(String(input)).pathname === "/v1/auth/refresh",
    )!;
    expect(JSON.parse(String(refresh?.body))).toEqual({ refresh_token: "rt-old" });
    // Both cookies rotate under the login's sid, and the refresh is marked as done.
    expect(cookies.get(ACCESS_COOKIE)?.value).toBe(bound(TOKENS.access_token));
    expect(cookies.get(REFRESH_COOKIE)?.value).toBe(bound(TOKENS.refresh_token));
    expect(cookies.get(REFRESHED_COOKIE)?.value).toBe("1");
    expect(cookies.get(SESSION_COOKIE)?.value).toBe(MARKER);
  });

  it("ends the session when the renewed token is refused too: one refresh, never a loop", async () => {
    cookies.reset({ [SESSION_COOKIE]: MARKER, [REFRESH_COOKIE]: bound("rt-old") });
    fetchMock.mockImplementation(
      routeFetch({
        "/v1/auth/me": unauthorized,
        "/v1/auth/refresh": () => Response.json(auth("agent")),
        "/v1/auth/logout": () => new Response(null, { status: 204 }),
      }),
    );

    expect(await redirectOf(staffActionAuth)).toBe(LOGIN_PATH);
    expect(calledPaths().filter((path) => path === "/v1/auth/refresh")).toHaveLength(1);
    expect(calledPaths().at(-1)).toBe("/v1/auth/logout");
    expect([...cookies.values.keys()]).toEqual([]);
  });

  it("does not refresh twice: a refused token after a refresh ends the session", async () => {
    cookies.reset({
      [SESSION_COOKIE]: MARKER,
      [ACCESS_COOKIE]: bound("at-new"),
      [REFRESH_COOKIE]: bound("rt-new"),
      [REFRESHED_COOKIE]: "1",
    });
    fetchMock.mockImplementation(
      routeFetch({
        "/v1/auth/me": unauthorized,
        "/v1/auth/logout": () => new Response(null, { status: 204 }),
      }),
    );

    expect(await redirectOf(staffActionAuth)).toBe(LOGIN_PATH);
    expect(calledPaths()).toEqual(["/v1/auth/me", "/v1/auth/logout"]);
    expect([...cookies.values.keys()]).toEqual([]);
  });

  it("goes to the login with the session cleared when the refresh is refused", async () => {
    cookies.reset({ [SESSION_COOKIE]: MARKER, [REFRESH_COOKIE]: bound("rt-old") });
    fetchMock.mockImplementation(routeFetch({ "/v1/auth/refresh": unauthorized }));

    expect(await redirectOf(staffActionAuth)).toBe(LOGIN_PATH);
    expect(calledPaths()).toEqual(["/v1/auth/refresh"]);
    expect([...cookies.values.keys()]).toEqual([]);
  });

  it.each(["customer", "pro"] as const)("ends the session of a %s account", async (role) => {
    cookies.reset({
      [SESSION_COOKIE]: MARKER,
      [ACCESS_COOKIE]: bound("at-1"),
      [REFRESH_COOKIE]: bound("rt-1"),
    });
    fetchMock.mockImplementation(
      routeFetch({
        "/v1/auth/me": () => Response.json(user(role)),
        "/v1/auth/logout": () => new Response(null, { status: 204 }),
      }),
    );

    expect(await redirectOf(staffActionAuth)).toBe(LOGIN_PATH);
    // Never a refresh for an account that is not staff; its refresh token is revoked.
    expect(calledPaths()).toEqual(["/v1/auth/me", "/v1/auth/logout"]);
    expect([...cookies.values.keys()]).toEqual([]);
  });

  it("goes to the login without a session, asking nothing of the API", async () => {
    cookies.reset({});

    expect(await redirectOf(staffActionAuth)).toBe(LOGIN_PATH);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("refreshStaffSession", () => {
  it("refresh_rotates_both_cookies", async () => {
    cookies.reset({
      [SESSION_COOKIE]: MARKER,
      [ACCESS_COOKIE]: bound("at-old"),
      [REFRESH_COOKIE]: bound("rt-old"),
    });
    fetchMock.mockImplementation(
      routeFetch({ "/v1/auth/refresh": () => Response.json(auth("agent")) }),
    );

    expect(await refreshStaffSession()).toBe(PANEL_PATH);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: "rt-old" });
    expect(cookies.get(ACCESS_COOKIE)?.value).toBe(bound(TOKENS.access_token));
    expect(cookies.get(REFRESH_COOKIE)?.value).toBe(bound(TOKENS.refresh_token));
    expect(cookies.get(REFRESHED_COOKIE)?.value).toBe("1");
  });

  it("clears the session and goes to the login when the refresh is refused", async () => {
    cookies.reset({
      [SESSION_COOKIE]: MARKER,
      [ACCESS_COOKIE]: bound("at-old"),
      [REFRESH_COOKIE]: bound("rt-old"),
    });
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
    cookies.reset({ [SESSION_COOKIE]: MARKER, [REFRESH_COOKIE]: bound("rt-old") });
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
    cookies.reset({
      [SESSION_COOKIE]: MARKER,
      [ACCESS_COOKIE]: bound("at-1"),
      [REFRESH_COOKIE]: bound("rt-1"),
      [REFRESHED_COOKIE]: "1",
    });
    fetchMock.mockImplementation(answer);

    await endSession();

    expect(cookies.values.size).toBe(0);
    expect(cookies.deletes.every((call) => call.path === "/admin")).toBe(true);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: "rt-1" });
  });
});
