import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bound, FakeCookieJar, RedirectSignal } from "@/lib/test-helpers";

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

import { ACCESS_COOKIE, LOGIN_PATH, REFRESH_COOKIE } from "@/lib/session";

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

async function visit(site: string | null): Promise<string> {
  const headers = site === null ? undefined : { "sec-fetch-site": site };
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

  it.each(["cross-site", "same-site"])(
    "a link from another site cannot sign anyone out (%s)",
    async (site) => {
      expect(await visit(site)).toBe(LOGIN_PATH);
      expect(cookies.get(REFRESH_COOKIE)?.value).toBe(bound("rt-1"));
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
