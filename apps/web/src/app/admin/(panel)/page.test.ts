import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCookieJar, RedirectSignal, routeFetch } from "@/lib/test-helpers";

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

import PanelHome from "./page";
import { decoded, me, signIn } from "./support/support-test-helpers";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  const cookies = new FakeCookieJar();
  jar.current = cookies;
  signIn(cookies);
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("panel home", () => {
  it("sends an agent to the operations queue", async () => {
    fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => me("agent") }));

    await expect(PanelHome()).rejects.toMatchObject(new RedirectSignal("/admin/queue"));
  });

  it("welcomes an admin with the way to the queue", async () => {
    fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => me("admin") }));

    const page = decoded(renderToStaticMarkup(await PanelHome()));

    expect(page).toContain("Welcome");
    expect(page).toMatch(/<a[^>]*href="\/admin\/queue"[^>]*>Open the operations queue/);
  });
});
