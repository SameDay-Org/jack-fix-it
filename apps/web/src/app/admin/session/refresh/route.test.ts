import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCookieJar, RedirectSignal } from "@/lib/test-helpers";

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

import { ACCESS_COOKIE, LOGIN_PATH, PANEL_PATH, REFRESH_COOKIE } from "@/lib/session";

import { GET } from "./route";

const fetchMock = vi.fn<typeof fetch>();
let cookies: FakeCookieJar;

beforeEach(() => {
  cookies = new FakeCookieJar();
  jar.current = cookies;
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("REFRESH_TOKEN_TTL_SECONDS", "604800");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

async function visit(site: string | null): Promise<string> {
  const headers = site === null ? undefined : { "sec-fetch-site": site };
  const request = new NextRequest("http://web.test.invalid/admin/session/refresh", { headers });
  try {
    await GET(request);
  } catch (signal) {
    if (signal instanceof RedirectSignal) return signal.url;
    throw signal;
  }
  throw new Error("expected a redirect");
}

describe("GET /admin/session/refresh", () => {
  // A top-level navigation from another site arrives without the Strict cookies, while the
  // browser still holds them: any Set-Cookie on this response would delete the real session.
  it.each([
    ["cross-site", {}],
    ["same-site", {}],
    ["cross-site", { [ACCESS_COOKIE]: "at-1", [REFRESH_COOKIE]: "rt-1" }],
  ])("a %s request writes no cookie and calls nothing", async (site, held) => {
    cookies.reset(held);

    expect(await visit(site)).toBe(PANEL_PATH);
    expect(cookies.sets).toEqual([]);
    expect(cookies.deletes).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["same-origin", "none", null])(
    "with no refresh cookie there is nothing to clear (sec-fetch-site: %s)",
    async (site) => {
      cookies.reset({});

      expect(await visit(site)).toBe(LOGIN_PATH);
      expect(cookies.sets).toEqual([]);
      expect(cookies.deletes).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
