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
    usePathname: () => "/admin/queue",
  };
});

import { decoded, me, signIn } from "./support/support-test-helpers";
import PanelLayout from "./layout";

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

async function render(role: "agent" | "customer", locale: string): Promise<string> {
  fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => me(role, locale) }));
  return decoded(renderToStaticMarkup(await PanelLayout({ children: "page" })));
}

describe("the panel shell", () => {
  it.each(["en", "es"])(
    "lets the navigation wrap on a phone and keeps one column from md up (%s)",
    async (locale) => {
      const html = await render("agent", locale);

      const nav = /<nav aria-label="([^"]+)" class="([^"]+)">(.*?)<\/nav>/.exec(html);
      expect(nav).not.toBeNull();
      const [, , classes, links] = nav ?? [];
      // Three links do not fit a 320 px screen on one line (Gatekeeper round 1 on #418).
      expect(classes?.split(" ")).toEqual(
        expect.arrayContaining(["flex", "flex-wrap", "md:flex-col", "md:flex-nowrap"]),
      );
      expect(links?.match(/<a /g)).toHaveLength(3);
      expect(links).toMatch(/<a aria-current="page" [^>]*href="\/admin\/queue"/);
    },
  );

  it("lets no one without a staff session see the shell", async () => {
    await expect(render("customer", "en")).rejects.toBeInstanceOf(RedirectSignal);
  });
});
