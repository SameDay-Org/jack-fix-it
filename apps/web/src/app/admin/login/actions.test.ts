import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auth, FakeCookieJar, RedirectSignal, routeFetch, TOKENS } from "@/lib/test-helpers";

const { jar } = vi.hoisted(() => ({ jar: { current: null as unknown } }));

vi.mock("next/headers", () => ({ cookies: async () => jar.current }));
vi.mock("next/navigation", async () => {
  const { RedirectSignal: Signal } = await import("@/lib/test-helpers");
  return {
    redirect: (url: string) => {
      throw new Signal(url);
    },
  };
});

import { ACCESS_COOKIE, REFRESH_COOKIE, SESSION_COOKIE } from "@/lib/session";

import { login } from "./actions";

const EMAIL = "staff.probe@example.com";
const PASSWORD = "probe-password-4821";
const fetchMock = vi.fn<typeof fetch>();
let cookies: FakeCookieJar;

beforeEach(() => {
  cookies = new FakeCookieJar();
  jar.current = cookies;
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("REFRESH_TOKEN_TTL_SECONDS", "2592000");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

function form(email = EMAIL, password = PASSWORD): FormData {
  const data = new FormData();
  data.set("email", email);
  data.set("password", password);
  return data;
}

async function submit(data: FormData = form()) {
  try {
    return { state: await login({ error: null, email: "" }, data), redirectedTo: null };
  } catch (signal) {
    if (signal instanceof RedirectSignal) return { state: null, redirectedTo: signal.url };
    throw signal;
  }
}

function calledPaths(): string[] {
  return fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
}

describe("login action", () => {
  it.each(["agent", "admin"] as const)("staff_login_sets_cookies (%s)", async (role) => {
    fetchMock.mockImplementation(routeFetch({ "/v1/auth/login": () => Response.json(auth(role)) }));

    const result = await submit(form(`  ${EMAIL}  `));

    expect(result.redirectedTo).toBe("/admin");
    // A new login: its session id prefixes both tokens and leads the marker.
    const sid = cookies.get(SESSION_COOKIE)?.value.split(".")[0];
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(cookies.get(SESSION_COOKIE)?.value).toBe(`${sid}.${auth(role).user.id}`);
    expect(cookies.get(ACCESS_COOKIE)?.value).toBe(`${sid}.${TOKENS.access_token}`);
    expect(cookies.get(REFRESH_COOKIE)?.value).toBe(`${sid}.${TOKENS.refresh_token}`);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ email: EMAIL, password: PASSWORD });
  });

  it.each(["customer", "pro"] as const)(
    "customer_or_pro_login_is_revoked_and_rejected (%s)",
    async (role) => {
      fetchMock.mockImplementation(
        routeFetch({
          "/v1/auth/login": () => Response.json(auth(role)),
          "/v1/auth/logout": () => new Response(null, { status: 204 }),
        }),
      );

      const result = await submit();

      expect(result.state).toEqual({ error: "not_staff", email: EMAIL });
      expect(calledPaths()).toEqual(["/v1/auth/login", "/v1/auth/logout"]);
      const [, logoutInit] = fetchMock.mock.calls[1]!;
      expect(JSON.parse(String(logoutInit?.body))).toEqual({
        refresh_token: TOKENS.refresh_token,
      });
      expect(cookies.sets).toEqual([]);
    },
  );

  it.each([
    [401, "invalid_credentials", "invalid_credentials"],
    [403, "account_suspended", "account_suspended"],
    [429, "rate_limited", "rate_limited"],
    [422, "validation_error", "invalid_credentials"],
    [500, "internal_error", "unavailable"],
  ])("maps_error_codes_to_messages (%i %s)", async (status, code, expected) => {
    fetchMock.mockResolvedValue(
      Response.json({ error: { code, message: "server text" } }, { status }),
    );

    const result = await submit();

    expect(result.state).toEqual({ error: expected, email: EMAIL });
    expect(cookies.sets).toEqual([]);
  });

  it("maps a network failure to the generic message", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    expect((await submit()).state).toEqual({ error: "unavailable", email: EMAIL });
  });

  it("refuses an empty form without calling the API", async () => {
    expect((await submit(form("", ""))).state).toEqual({ error: "invalid_credentials", email: "" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no_tokens_or_password_in_logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    fetchMock.mockImplementation(
      routeFetch({
        "/v1/auth/login": () => Response.json(auth("customer")),
        "/v1/auth/logout": () => Promise.reject(new TypeError("fetch failed")),
      }),
    );

    await submit();
    fetchMock.mockReset();
    fetchMock.mockImplementation(
      routeFetch({ "/v1/auth/login": () => Response.json(auth("admin")) }),
    );
    await submit();

    const logged = spies
      .flatMap((spy) => spy.mock.calls.flat())
      .map(String)
      .join("\n");
    for (const secret of [PASSWORD, EMAIL, TOKENS.access_token, TOKENS.refresh_token]) {
      expect(logged).not.toContain(secret);
    }
  });
});
