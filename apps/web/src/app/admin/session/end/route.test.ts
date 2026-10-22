import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bound, FakeCookieJar, MARKER, RedirectSignal } from "@/lib/test-helpers";

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

import { ACCESS_COOKIE, LOGIN_PATH, REFRESH_COOKIE, SESSION_COOKIE } from "@/lib/session";

import { GET } from "./route";

const fetchMock = vi.fn<typeof fetch>();
let cookies: FakeCookieJar;

beforeEach(() => {
  cookies = new FakeCookieJar();
  cookies.reset({ [ACCESS_COOKIE]: bound("at-1"), [REFRESH_COOKIE]: bound("rt-1") });
  jar.current = cookies;
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

/** The request carries exactly the cookies in the jar (what the browser sent). */
async function visit(site: string | null): Promise<string> {
  const headers = new Headers();
  if (site !== null) headers.set("sec-fetch-site", site);
  const sent = [...cookies.values].map(([name, value]) => `${name}=${value}`).join("; ");
  if (sent) headers.set("cookie", sent);
  const request = new NextRequest("http://web.test.invalid/admin/session/end", { headers });
  try {
    await GET(request);
  } catch (signal) {
    if (signal instanceof RedirectSignal) return signal.url;
    throw signal;
  }
  throw new Error("expected a redirect");
}

describe("GET /admin/session/end", () => {
  it.each(["same-origin", "none", null])("ends the session (sec-fetch-site: %s)", async (site) => {
    expect(await visit(site)).toBe(LOGIN_PATH);
    expect(cookies.values.size).toBe(0);
  });

  // An old browser (no Fetch Metadata, e.g. Safari before 16.4) following a link from another
  // site sends neither Sec-Fetch-Site nor the Strict cookies: nothing may change (#158 V1).
  it.each(["same-origin", "none", null])(
    "a request without session cookies changes nothing (sec-fetch-site: %s)",
    async (site) => {
      cookies.reset({});

      expect(await visit(site)).toBe(LOGIN_PATH);
      expect(cookies.sets).toEqual([]);
      expect(cookies.deletes).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("an old browser that sends the session cookies is signed out, as today", async () => {
    cookies.reset({
      [SESSION_COOKIE]: MARKER,
      [ACCESS_COOKIE]: bound("at-1"),
      [REFRESH_COOKIE]: bound("rt-1"),
    });

    expect(await visit(null)).toBe(LOGIN_PATH);
    expect(cookies.values.size).toBe(0);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: "rt-1" });
  });

  it.each(["cross-site", "same-site"])(
    "a link from another site cannot sign anyone out (%s)",
    async (site) => {
      expect(await visit(site)).toBe(LOGIN_PATH);
      expect(cookies.get(REFRESH_COOKIE)?.value).toBe(bound("rt-1"));
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
