import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auth, bound, FakeCookieJar, MARKER, RedirectSignal, routeFetch } from "@/lib/test-helpers";

// The panel's return address end to end (#464): the page a signed-out staff member asked for
// goes from the proxy's header through the session routes and the login form, and back.
const { jar, requested } = vi.hoisted(() => ({
  jar: { current: null as unknown },
  requested: { path: null as string | null },
}));

vi.mock("next/headers", () => ({
  cookies: async () => jar.current,
  headers: async () => new Headers(requested.path === null ? {} : { "x-jfi-path": requested.path }),
}));
vi.mock("next/navigation", async () => {
  const { RedirectSignal: Signal } = await import("@/lib/test-helpers");
  return {
    redirect: (url: string) => {
      throw new Signal(url);
    },
  };
});

import { config, proxy } from "@/proxy";
import { PATH_HEADER } from "@/lib/return-path";
import { ACCESS_COOKIE, REFRESH_COOKIE, requireStaff, SESSION_COOKIE } from "@/lib/session";

import { login } from "./login/actions";
import LoginPage from "./login/page";
import { GET as end } from "./session/end/route";
import { GET as refresh } from "./session/refresh/route";

const PROBES = [
  "//evil.example",
  "https://evil.example",
  "/\\evil.example",
  "/%5Cevil.example",
  "%2F%2Fevil.example",
  "/admin/..//evil.example",
  "/admin@evil.example",
];
const fetchMock = vi.fn<typeof fetch>();
let cookies: FakeCookieJar;

beforeEach(() => {
  cookies = new FakeCookieJar();
  jar.current = cookies;
  requested.path = null;
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("REFRESH_TOKEN_TTL_SECONDS", "2592000");
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

/** A same-origin request with the jar's cookies, as the browser sends it. */
function request(url: string): NextRequest {
  const headers = new Headers({ "sec-fetch-site": "same-origin" });
  const sent = [...cookies.values].map(([name, value]) => `${name}=${value}`).join("; ");
  if (sent) headers.set("cookie", sent);
  return new NextRequest(`http://web.test.invalid${url}`, { headers });
}

const nextOf = (url: string) => new URL(url, "http://x").searchParams.get("next");

describe("the return address through sign-in (#464)", () => {
  it("requireStaff sends a signed-out staff member to the session end with the page asked for", async () => {
    requested.path = "/admin/disputes/6b3c0e1d-1111-4222-8333-944455556666?x=1";

    const target = await redirectOf(requireStaff);

    expect(target.startsWith("/admin/session/end?next=")).toBe(true);
    expect(nextOf(target)).toBe("/admin/disputes/6b3c0e1d-1111-4222-8333-944455556666?x=1");
  });

  it.each(PROBES)("requireStaff drops a header that is not a panel path (%j)", async (probe) => {
    requested.path = probe;

    expect(await redirectOf(requireStaff)).toBe("/admin/session/end");
  });

  it("the session end passes the page on to the login, validated again", async () => {
    expect(
      nextOf(await redirectOf(() => end(request("/admin/session/end?next=%2Fadmin%2Fqueue")))),
    ).toBe("/admin/queue");
    for (const probe of PROBES) {
      const target = await redirectOf(() =>
        end(request(`/admin/session/end?next=${encodeURIComponent(probe)}`)),
      );
      expect(target, probe).toBe("/admin/login");
    }
  });

  it("the refresh returns to the page once the session is renewed, else to the login with it", async () => {
    cookies.reset({
      [SESSION_COOKIE]: MARKER,
      [ACCESS_COOKIE]: bound("at-1"),
      [REFRESH_COOKIE]: bound("rt-1"),
    });
    fetchMock.mockImplementation(
      routeFetch({ "/v1/auth/refresh": () => Response.json(auth("agent")) }),
    );

    expect(
      await redirectOf(() =>
        refresh(request("/admin/session/refresh?next=%2Fadmin%2Fkpis%3Fdays%3D7")),
      ),
    ).toBe("/admin/kpis?days=7");

    cookies.reset({
      [SESSION_COOKIE]: MARKER,
      [ACCESS_COOKIE]: bound("at-1"),
      [REFRESH_COOKIE]: bound("rt-1"),
    });
    fetchMock.mockImplementation(
      routeFetch({ "/v1/auth/refresh": () => Response.json({}, { status: 401 }) }),
    );
    expect(
      nextOf(
        await redirectOf(() => refresh(request("/admin/session/refresh?next=%2Fadmin%2Fkpis"))),
      ),
    ).toBe("/admin/kpis");

    for (const probe of PROBES) {
      cookies.reset({
        [SESSION_COOKIE]: MARKER,
        [ACCESS_COOKIE]: bound("at-1"),
        [REFRESH_COOKIE]: bound("rt-1"),
      });
      fetchMock.mockImplementation(
        routeFetch({ "/v1/auth/refresh": () => Response.json(auth("agent")) }),
      );
      const target = await redirectOf(() =>
        refresh(request(`/admin/session/refresh?next=${encodeURIComponent(probe)}`)),
      );
      expect(target, probe).toBe("/admin");
    }
  });

  it("the login page carries a panel path in its form, and nothing else", async () => {
    const page = async (next: string) =>
      renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ next }) }));

    expect(await page("/admin/queue?tab=urgent")).toContain(
      '<input type="hidden" name="next" value="/admin/queue?tab=urgent"/>',
    );
    for (const probe of PROBES) expect(await page(probe), probe).not.toContain('name="next"');
  });

  it("signing in opens the page asked for; a probe or nothing opens the panel", async () => {
    const signIn = async (next: string | null) => {
      fetchMock.mockImplementation(
        routeFetch({ "/v1/auth/login": () => Response.json(auth("admin")) }),
      );
      const data = new FormData();
      data.set("email", "staff.probe@example.com");
      data.set("password", "probe-password-4821");
      if (next !== null) data.set("next", next);
      return redirectOf(() => login({ error: null, email: "" }, data));
    };

    expect(await signIn("/admin/disputes?status=resolved")).toBe("/admin/disputes?status=resolved");
    expect(await signIn(null)).toBe("/admin");
    for (const probe of PROBES) expect(await signIn(probe), probe).toBe("/admin");
  });

  it("the proxy writes the page's path and query, over any value the client sent", () => {
    const incoming = new NextRequest("http://web.test.invalid/admin/queue?tab=urgent", {
      headers: { [PATH_HEADER]: "https://evil.example" },
    });

    const response = proxy(incoming);

    expect(response.headers.get(`x-middleware-request-${PATH_HEADER}`)).toBe(
      "/admin/queue?tab=urgent",
    );
    // The panel only: the public pages stay static and untouched.
    expect(config.matcher).toEqual(["/admin", "/admin/:path*"]);
  });
});
