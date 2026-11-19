import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Locale } from "@/i18n/config";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import * as enRoute from "@/app/(marketing)/[slug]/page";
import * as esRoute from "@/app/(marketing)/es/[slug]/page";

import {
  CATALOG_REVALIDATE_SECONDS,
  CatalogUnavailableError,
  type Category,
  type Region,
} from "./catalog";
import { serviceMetadata } from "./metadata";
import {
  CLEANING,
  PAINTING,
  POOLS,
  SOUTH_FLORIDA,
  TREASURE_COAST,
  catalogFetch,
} from "./seo-test-helpers";
import { ServicePage } from "./service-page";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("CONTACT_EMAIL", "");
  vi.stubEnv("SITE_URL", "");
  vi.stubGlobal("fetch", fetchMock);
  serve([CLEANING, PAINTING, POOLS], [SOUTH_FLORIDA]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function serve(categories: Category[], regions: Region[]): void {
  fetchMock.mockImplementation(catalogFetch(categories, regions));
}

function decoded(html: string): string {
  return html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

async function page(locale: Locale, slug: string): Promise<string> {
  return decoded(renderToStaticMarkup(await ServicePage({ locale, slug })));
}

/** The page's visible words, tags dropped. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("a service's page", () => {
  it("says what the service is, where, and what the app asks, in English", async () => {
    const html = await page("en", "house-cleaning");

    expect(html).toMatch(/<h1 id="hero-title"[^>]*>House Cleaning in South Florida<\/h1>/);
    expect(html).toContain("Regular or one-time cleaning for your home.");
    // The API's questions and choices, as the app asks them.
    expect(html).toContain("How many bedrooms?");
    expect(html).toContain("How often do you need cleaning?");
    expect(html).toMatch(/One time.*Recurring.*Weekly or every other week/s);
    // Where Jack works: the served cities, as stored.
    expect(html).toContain("Fort Lauderdale, FL");
    expect(html).toContain("Hollywood, FL");
    // The other services, and the way to the app (the web request flow is #86).
    expect(html).toMatch(/<a[^>]*href="\/painting"[^>]*>Painting<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/pool-care"[^>]*>Pool Care<\/a>/);
    expect(html).not.toMatch(/href="\/house-cleaning"[^>]*>House Cleaning<\/a>/);
    expect(html.match(/href="\/app"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(/^<div lang="en">/);
  });

  it("is in Spanish under /es, with the same slugs and the API's Spanish text", async () => {
    const html = await page("es", "painting");

    expect(html).toMatch(/^<div lang="es">/);
    expect(html).toMatch(/<h1 id="hero-title"[^>]*>Pintura en South Florida<\/h1>/);
    expect(html).toContain("¿Qué trabajos necesitas?");
    expect(html).toMatch(/Pintura interior.*Paredes de una o más habitaciones/s);
    expect(html).toMatch(/<a[^>]*href="\/es\/house-cleaning"[^>]*>Limpieza del hogar<\/a>/);
    expect(html).toContain('href="/es/app"');
    // Every language switch (header and footer) leads to this page's twin.
    const switches = [...html.matchAll(/<a[^>]*hrefLang="(en|es)"[^>]*>/g)].map((m) => [
      m[1],
      /href="([^"]+)"/.exec(m[0])?.[1],
    ]);
    expect(switches.length).toBeGreaterThanOrEqual(4);
    for (const [language, href] of switches) {
      expect(href, language).toBe(language === "en" ? "/painting" : "/es/painting");
    }
    for (const english of ["How it works", "Where Jack works", "Get the app", "Skip to"]) {
      expect(html, english).not.toContain(english);
    }
  });

  it("links its header and hero to sections that exist", async () => {
    const html = await page("en", "house-cleaning");
    const anchors = new Set([...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]));

    expect(anchors).toEqual(new Set(["content", "ask", "areas"]));
    for (const anchor of anchors) expect(html, anchor).toContain(`id="${anchor}"`);
    expect(html).toContain('href="/for-pros"');
  });

  it("gives a category added later the general line, and asks it in the reader's words", async () => {
    const html = await page("en", "pool-care");

    expect(html).toMatch(/<h1[^>]*>Pool Care in South Florida<\/h1>/);
    expect(html).toContain("Tell Jack what you need.");
    expect(html).toContain("Tell Jack what you need, in your own words.");
    expect(html).not.toContain('<ol class="mt-10 grid');
  });

  it("names every region, and no single place in the headline, when Jack serves several", async () => {
    serve([CLEANING], [SOUTH_FLORIDA, TREASURE_COAST]);
    const html = await page("en", "house-cleaning");

    expect(html).toMatch(/<h1[^>]*>House Cleaning<\/h1>/);
    expect(html).toMatch(/<h3[^>]*>South Florida<\/h3>/);
    expect(html).toMatch(/<h3[^>]*>Treasure Coast<\/h3>/);
    expect(html).toContain("Stuart, FL");
    expect(html).not.toContain("More from Jack"); // no other service to offer
  });

  it.each([
    ["an unknown slug", "handyman", [CLEANING]],
    ["a slug in capitals", "House-Cleaning", [CLEANING]],
    ["a reserved slug the API lists", "app", [{ ...POOLS, slug: "app" }]],
    ["an inactive category (the API lists only active ones)", "painting", [CLEANING]],
  ])("is a 404 for %s", async (_case, slug, categories) => {
    serve(categories as Category[], [SOUTH_FLORIDA]);

    await expect(ServicePage({ locale: "en", slug: slug as string })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("is a 404 while no city has an active ZIP", async () => {
    serve([CLEANING], []);

    await expect(ServicePage({ locale: "en", slug: "house-cleaning" })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("throws, never a 404 or an empty page, when the API cannot answer", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(ServicePage({ locale: "en", slug: "house-cleaning" })).rejects.toBeInstanceOf(
      CatalogUnavailableError,
    );
    await expect(serviceMetadata("en", "house-cleaning")).rejects.toBeInstanceOf(
      CatalogUnavailableError,
    );
  });

  // The landing's and the legal rules' words (landing-page.test.ts, i18n/public-copy.test.ts),
  // on the rendered page: its own copy and the API's text together. "Fixed-price quotes" is
  // the landing's approved wording for what pros send; any other price is not.
  const absent: Record<Locale, RegExp> = {
    en: /\$|%|(?<!fixed-)price|\bfees?\b|review|rating|\bstars?\b|\bfree\b|licens|insur|guarant|warrant|escrow|refund|\bpros? (available|nearby now)\b|\d+\s*(pros|jobs|customers)/i,
    es: /\$|%|precio(?! fijo)|tarifa|reseña|calificaci|estrellas|gratis|licencia|asegurad|garant|reembols|\d+\s*(profesionales|trabajos|clientes)/i,
  };

  it.each(["en", "es"] as const)(
    "in %s shows no price, count, review or legal promise",
    async (locale) => {
      for (const slug of ["house-cleaning", "painting", "pool-care"]) {
        const text = textOf(await page(locale, slug));
        const hit = absent[locale].exec(text);
        // The words around a hit, so a failure says where it is.
        expect(hit && text.slice(Math.max(0, hit.index - 50), hit.index + 30), slug).toBeNull();
      }
    },
  );
});

describe("a service's metadata", () => {
  it("titles and describes the page, with its canonical and its /es twin", async () => {
    vi.stubEnv("SITE_URL", "https://jackfixit.example");

    const en = await serviceMetadata("en", "house-cleaning");
    const es = await serviceMetadata("es", "house-cleaning");

    expect(en.title).toBe("House Cleaning in South Florida | Jack Fix It");
    expect(en.description).toBe(
      "House Cleaning in South Florida: tell Jack about the job, compare fixed-price quotes from pros near you and follow it in the app.",
    );
    expect(en.alternates).toEqual({
      canonical: "/house-cleaning",
      languages: {
        en: "/house-cleaning",
        es: "/es/house-cleaning",
        "x-default": "/house-cleaning",
      },
    });
    expect(en.openGraph).toMatchObject({ url: "/house-cleaning", locale: "en_US" });
    expect(es.title).toBe("Limpieza del hogar en South Florida | Jack Fix It");
    expect(es.alternates?.canonical).toBe("/es/house-cleaning");
    expect(es.openGraph).toMatchObject({ url: "/es/house-cleaning", locale: "es_US" });
    expect(String(en.description).length).toBeLessThanOrEqual(155);
  });

  it("names no place when Jack serves several regions", async () => {
    serve([CLEANING], [SOUTH_FLORIDA, TREASURE_COAST]);

    expect((await serviceMetadata("en", "house-cleaning")).title).toBe(
      "House Cleaning | Jack Fix It",
    );
  });

  it("is a 404 for a slug without a page", async () => {
    await expect(serviceMetadata("en", "app")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("the service routes", () => {
  it("are made on first visit and kept as long as the catalog read, in both languages", () => {
    for (const route of [enRoute, esRoute]) {
      expect(route.revalidate).toBe(CATALOG_REVALIDATE_SECONDS);
      expect(route.generateStaticParams()).toEqual([]);
    }
  });

  it("render their own language", async () => {
    const params = Promise.resolve({ slug: "painting" });

    expect((await enRoute.default({ params })).props).toEqual({ locale: "en", slug: "painting" });
    expect((await esRoute.default({ params })).props).toEqual({ locale: "es", slug: "painting" });
    expect((await esRoute.generateMetadata({ params })).title).toBe(
      "Pintura en South Florida | Jack Fix It",
    );
  });
});
