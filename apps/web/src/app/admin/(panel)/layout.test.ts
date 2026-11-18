import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCookieJar, RedirectSignal, routeFetch } from "@/lib/test-helpers";

const { jar, path } = vi.hoisted(() => ({
  jar: { current: null as unknown },
  path: { current: "/admin" },
}));

vi.mock("next/headers", () => ({ cookies: async () => jar.current }));
vi.mock("next/navigation", async () => {
  const { RedirectSignal: Signal } = await import("@/lib/test-helpers");
  return {
    redirect: (url: string) => {
      throw new Signal(url);
    },
    usePathname: () => path.current,
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

async function render(role: "agent" | "admin" | "customer", locale: string): Promise<string> {
  fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => me(role, locale) }));
  return decoded(renderToStaticMarkup(await PanelLayout({ children: "page" })));
}

describe("the panel shell", () => {
  it.each(["en", "es"])(
    "lets the navigation wrap on a phone and keeps one column from md up (%s)",
    async (locale) => {
      path.current = "/admin/queue";
      const html = await render("agent", locale);

      const nav = /<nav aria-label="([^"]+)" class="([^"]+)">(.*?)<\/nav>/.exec(html);
      expect(nav).not.toBeNull();
      const [, , classes, links] = nav ?? [];
      // The links do not fit a 320 px screen on one line (Gatekeeper round 1 on #418).
      expect(classes?.split(" ")).toEqual(
        expect.arrayContaining(["flex", "flex-wrap", "md:flex-col", "md:flex-nowrap"]),
      );
      expect(links?.match(/<a /g)).toHaveLength(6);
      expect(links).toMatch(/<a aria-current="page" [^>]*href="\/admin\/queue"/);
    },
  );

  it("lets the Spanish navigation wrap on a phone and keeps one column from md up", async () => {
    path.current = "/admin/pros";
    const html = await render("agent", "es");

    const nav = /<nav aria-label="([^"]+)" class="([^"]+)">(.*?)<\/nav>/.exec(html);
    expect(nav).not.toBeNull();
    const [, , classes, links] = nav ?? [];
    // Three links in Spanish do not fit a 320 px screen on one line (Gatekeeper round 1 on #415).
    expect(classes?.split(" ")).toEqual(
      expect.arrayContaining(["flex", "flex-wrap", "md:flex-col", "md:flex-nowrap"]),
    );
    expect(links).toContain("Inicio");
    expect(links).toContain("Soporte");
    expect(links).toMatch(/<a aria-current="page" [^>]*href="\/admin\/pros"/);
  });

  it.each([
    ["agent", "en", "Disputes"],
    ["admin", "en", "Disputes"],
    ["agent", "es", "Disputas"],
    ["admin", "es", "Disputas"],
  ] as const)(
    "links the disputes for an %s (%s), marked when open",
    async (role, locale, label) => {
      path.current = "/admin/disputes/2a7d0c4e-1111-4222-8333-944455556666";
      const html = await render(role, locale);
      const links = /<nav [^>]*>(.*?)<\/nav>/.exec(html)?.[1] ?? "";
      expect(links).toMatch(
        new RegExp(`<a aria-current="page" [^>]*href="/admin/disputes"[^>]*>.*?${label}</a>`),
      );
    },
  );

  it.each([
    ["agent", "en", "KPIs"],
    ["admin", "en", "KPIs"],
    ["agent", "es", "Indicadores"],
  ] as const)("links the KPIs for an %s (%s), marked when open", async (role, locale, name) => {
    path.current = "/admin/kpis";
    const html = await render(role, locale);

    const links = /<nav [^>]*>(.*?)<\/nav>/.exec(html)?.[1] ?? "";
    expect(links).toMatch(
      new RegExp(`<a aria-current="page" [^>]*href="/admin/kpis"[^>]*>.*?${name}</a>`),
    );
    expect(links.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("lets no one without a staff session see the shell", async () => {
    await expect(render("customer", "en")).rejects.toBeInstanceOf(RedirectSignal);
  });
});
