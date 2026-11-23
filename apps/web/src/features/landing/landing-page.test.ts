import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Locale } from "@/i18n/config";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import { routeFetch } from "@/lib/test-helpers";

import { SHIPPED_CATEGORY_SLUGS } from "./categories";
import { LandingPage, REQUEST_FLOW_ANCHOR } from "./landing-page";
import { landingMetadata } from "./metadata";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "../../app");
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("CONTACT_EMAIL", "");
  vi.stubEnv("REQUEST_FLOW_ENABLED", "");
  vi.stubEnv("SITE_URL", "");
  vi.stubGlobal("fetch", fetchMock);
  // The API is down unless a test says otherwise.
  fetchMock.mockRejectedValue(new TypeError("fetch failed"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function decoded(html: string): string {
  return html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

async function page(locale: Locale): Promise<string> {
  return decoded(renderToStaticMarkup(await LandingPage({ locale })));
}

const CATALOGS = { en, es } as const;

/** The site's routes, from the page files under src/app (route groups are not in the URL). */
function routes(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string, segments: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const group = /^\(.+\)$/.test(entry.name);
        walk(join(dir, entry.name), group ? segments : [...segments, entry.name]);
      } else if (entry.name === "page.tsx") {
        found.add(`/${segments.join("/")}`);
      }
    }
  };
  walk(appDir, []);
  return found;
}

describe("the landing page", () => {
  it.each(["en", "es"] as const)(
    "in %s has its sections in the plan's order, one h1",
    async (locale) => {
      const html = await page(locale);
      expect(html).toMatch(new RegExp(`^<div lang="${locale}">`));
      expect(html.match(/<h1/g)).toHaveLength(1);
      const order = [
        'id="top"',
        'id="how"',
        'id="services"',
        'aria-labelledby="trust-title"',
        'id="pros"',
      ];
      const positions = order.map((marker) => html.indexOf(marker));
      expect(positions.every((position) => position > 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(html.indexOf("<header")).toBeLessThan(html.indexOf("<main"));
      expect(html.indexOf("</main>")).toBeLessThan(html.indexOf("<footer"));
      expect(html).toContain('href="#content"');
    },
  );

  // Both language switches are on screen at once, so they need two names (axe
  // landmark-unique). The header's links and the phone menu share one: only one is ever shown.
  it.each([
    ["en", ["Language", "Language (footer)"]],
    ["es", ["Idioma", "Idioma (pie de página)"]],
  ] as const)("in %s names its two language switches apart", async (locale, names) => {
    const html = await page(locale);
    const switches = [
      ...html.matchAll(/<nav aria-label="([^"]+)"[^>]*>(?:(?!<\/nav>)[\s\S])*?hrefLang=/g),
    ];

    expect(switches.map((m) => m[1])).toEqual(names);
  });

  it("names its sections, and every anchor it links to is on the page", async () => {
    const html = await page("en");
    const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]!);
    expect(new Set(anchors)).toEqual(new Set(["content", "top", "services", "how"]));
    for (const anchor of anchors) expect(html).toContain(`id="${anchor}"`);
  });

  it("draws John from the mascot package as still images, none of him in the HTML", async () => {
    const html = await page("en");
    // Drawn inline to move, the hero's John made the HTML a network round trip longer before
    // the first paint, so every mascot here is an image of the package's drawing.
    expect(html).not.toMatch(/<svg[^>]*data-pose=|data-part=|data-motion/);
    const images = html.match(/<img[^>]*data-pose="[^"]*"[^>]*>/g) ?? [];
    expect(images.map((image) => /data-pose="([^"]*)"/.exec(image)?.[1])).toEqual([
      "wave",
      "thinking",
      "point",
      "tools",
      "celebrate",
    ]);
    for (const image of images) expect(image).toMatch(/src="\/mascot\/[a-z]+\.svg" alt=""/);
    // All lazy: the hero's is hidden on a phone, and a preload would fetch it there anyway.
    expect(html).not.toContain('rel="preload" as="image"');
    expect(images.every((image) => image.includes('loading="lazy"'))).toBe(true);
  });

  it.each(["en", "es"] as const)("in %s links only to pages that exist", async (locale) => {
    const html = await page(locale);
    const known = routes();
    const internal = [...html.matchAll(/href="(\/[^"]*)"/g)].map((match) => match[1]!);
    expect(internal.length).toBeGreaterThan(4);
    for (const href of internal) {
      const path = href.split(/[?#]/)[0]!;
      expect(known, href).toContain(path === "" ? "/" : path);
    }
  });

  it.each([
    ["en", "/for-pros", "/app#pros"],
    ["es", "/es/for-pros", "/es/app#pros"],
  ] as const)(
    "in %s links to the page for professionals from its header, its pros block and its footer",
    async (locale, forPros, appForPros) => {
      const html = await page(locale);
      const part = (open: RegExp, close: string) => {
        const start = html.search(open);
        return html.slice(start, html.indexOf(close, start));
      };
      const link = new RegExp(`<a [^>]*href="${forPros}"`);
      expect(part(/<header\b/, "</header>")).toMatch(link);
      const block = part(/<section id="pros"/, "</section>");
      expect(block).toMatch(link);
      // The block's second way keeps the app's part for pros.
      expect(block).toContain(`href="${appForPros}"`);
      expect(part(/<footer\b/, "</footer>")).toMatch(link);
      // A real page, not a dead link.
      expect(routes()).toContain(forPros);
    },
  );

  it("shows the API's categories, in the reader's language, a new one with the general line", async () => {
    fetchMock.mockImplementation(
      routeFetch({
        "/v1/categories": () =>
          Response.json([
            {
              id: "1",
              slug: "handyman",
              names: { en: "Handyman", es: "Reparaciones generales" },
              icon: null,
              requires_license: false,
              intake_questions: [],
            },
            {
              id: "2",
              slug: "roof-repair",
              names: { en: "Roof Repair", es: "Reparación de techos" },
              icon: null,
              requires_license: true,
              intake_questions: [],
            },
          ]),
      }),
    );
    const html = await page("es");
    expect(html).toContain("Reparaciones generales");
    expect(html).toContain(es.landing.services.lines.handyman);
    expect(html).toContain("Reparación de techos");
    expect(html).toContain(es.landing.services.other);
    expect(html).not.toContain(es.landing.services.names.painting);
  });

  it.each(["en", "es"] as const)(
    "in %s falls back to the shipped categories when the API cannot be read",
    async (locale) => {
      const html = await page(locale);
      for (const slug of SHIPPED_CATEGORY_SLUGS) {
        expect(html).toContain(CATALOGS[locale].landing.services.names[slug]);
        expect(html).toContain(CATALOGS[locale].landing.services.lines[slug]);
      }
    },
  );

  it("falls back to the categories the API ships, never others", () => {
    const seed = JSON.parse(
      readFileSync(join(here, "../../../../api/app/modules/categories/seed_data.json"), "utf8"),
    ) as { slug: string; names: Record<Locale, string> }[];
    expect([...SHIPPED_CATEGORY_SLUGS]).toEqual(seed.map((category) => category.slug));
    for (const category of seed) {
      for (const locale of ["en", "es"] as const) {
        const names: Record<string, string> = CATALOGS[locale].landing.services.names;
        expect(names[category.slug]).toBe(category.names[locale]);
      }
    }
  });

  it("sends the reader to the app until the web request flow ships, then to it (one flag)", async () => {
    let html = await page("en");
    expect(html).not.toContain(`id="${REQUEST_FLOW_ANCHOR}"`);
    expect(html).not.toContain(en.landing.requestFlow.cta);
    expect(html).toMatch(/<a[^>]*href="\/app"[^>]*>Get the app<\/a>/);

    vi.stubEnv("REQUEST_FLOW_ENABLED", "true");
    html = await page("en");
    expect(html).toContain(`id="${REQUEST_FLOW_ANCHOR}"`);
    expect(html).toContain(en.landing.requestFlow.title);
    expect(html).toMatch(
      new RegExp(`<a[^>]*href="#${REQUEST_FLOW_ANCHOR}"[^>]*>${en.landing.requestFlow.cta}</a>`),
    );
  });

  it.each([
    ["set", "hello@jackfixit.test", true],
    ["unset", "", false],
    ["not an address", "javascript:alert(1)", false],
  ])("shows Contact only when CONTACT_EMAIL is an address (%s)", async (_, value, shown) => {
    vi.stubEnv("CONTACT_EMAIL", value);
    const html = await page("en");
    expect(html.includes(`href="mailto:${value}"`)).toBe(shown);
    expect(html.includes(">Contact<")).toBe(shown);
  });

  it.each(["en", "es"] as const)("in %s asks nothing of another site", async (locale) => {
    const html = (await page(locale)).replaceAll('xmlns="http://www.w3.org/2000/svg"', "");
    expect(html).not.toMatch(/https?:\/\/|<script[^>]+src=|<iframe|<link[^>]+href="http/);
  });
});

describe("the landing's copy", () => {
  // The legal text rules (insurance, warranty, escrow, licence, refund, payment promises, where
  // "verified" may appear) are the shared public-copy policy's: i18n/public-copy.test.ts reads
  // the landing too. Here, what the landing must not offer because the product does not have it:
  // voice input, reviews or ratings, a customer sign-in, prices, anything "free".
  const absent: Record<Locale, RegExp> = {
    en: /\bfree\b|\bvoice\b|review|rating|sign[ -]?in|log[ -]?in|\d+\s*%|\$\d/i,
    es: /gratis|gratuit|\bvoz\b|reseña|calificaci|inici(a|ar) sesi[oó]n|\d+\s*%|\$\d/i,
  };

  it.each(["en", "es"] as const)("in %s offers nothing the product does not have", (locale) => {
    const strings = (value: unknown): string[] =>
      typeof value === "string" ? [value] : Object.values(value as object).flatMap(strings);
    for (const text of strings(CATALOGS[locale].landing))
      expect(text, text).not.toMatch(absent[locale]);
  });
});

describe("the landing's metadata", () => {
  it.each(["en", "es"] as const)(
    "in %s has its title and description, and no address without SITE_URL",
    async (locale) => {
      const metadata = await landingMetadata(locale);
      expect(metadata.title).toBe(CATALOGS[locale].landing.meta.title);
      expect(metadata.description).toBe(CATALOGS[locale].landing.meta.description);
      expect(metadata.alternates).toBeUndefined();
    },
  );

  it.each([
    ["en", "/"],
    ["es", "/es"],
  ] as const)("in %s names itself and its twin with SITE_URL", async (locale, canonical) => {
    vi.stubEnv("SITE_URL", "https://jackfixit.test");
    const metadata = await landingMetadata(locale);
    expect(metadata.alternates).toEqual({
      canonical,
      languages: { en: "/", es: "/es", "x-default": "/" },
    });
    expect(metadata.openGraph).toMatchObject({
      url: canonical,
      locale: locale === "en" ? "en_US" : "es_US",
    });
  });
});
