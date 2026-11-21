import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Locale } from "@/i18n/config";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import * as enRoute from "@/app/(marketing)/[slug]/[service]/page";
import * as esRoute from "@/app/(marketing)/es/[slug]/[service]/page";

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

async function page(locale: Locale, city: string, slug: string): Promise<string> {
  return decoded(renderToStaticMarkup(await ServicePage({ locale, slug, city })));
}

const hrefs = (html: string) => [...html.matchAll(/href="([^"#]+)"/g)].map((m) => m[1]);

describe("a service's page for one city", () => {
  it("names the service in the city, its ZIP codes, and the same service elsewhere", async () => {
    const html = await page("en", "fort-lauderdale", "painting");

    expect(html).toMatch(/<h1 id="hero-title"[^>]*>Painting in Fort Lauderdale, FL<\/h1>/);
    expect(html).toContain("Rooms, walls and touch-ups.");
    expect(html).toContain("Which jobs do you need?");
    expect(html).toMatch(/<h2 id="areas-title"[^>]*>Where Jack works in Fort Lauderdale, FL<\/h2>/);
    expect(html).toMatch(/aria-label="ZIP codes served"[^>]*>.*33301.*33304.*<\/ul>/s);
    expect(html).not.toContain("33019"); // Hollywood's ZIP stays on Hollywood's page
    expect(html).toContain("Painting in other cities");
    expect(html).toMatch(/<a[^>]*href="\/hollywood\/painting"[^>]*>Hollywood, FL<\/a>/);
    // The other services, in this city.
    expect(html).toContain("More from Jack in Fort Lauderdale, FL");
    expect(hrefs(html)).toEqual(
      expect.arrayContaining(["/fort-lauderdale/house-cleaning", "/fort-lauderdale/pool-care"]),
    );
    const more = html.slice(html.indexOf('aria-labelledby="more-title"'));
    expect(hrefs(more.slice(0, more.indexOf("</nav>")))).not.toContain("/fort-lauderdale/painting");
    expect(html.match(/href="\/app"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("is in Spanish under /es, with the same slugs, and switches language to its twin", async () => {
    const html = await page("es", "hollywood", "house-cleaning");

    expect(html).toMatch(/^<div lang="es">/);
    expect(html).toMatch(/<h1[^>]*>Limpieza del hogar en Hollywood, FL<\/h1>/);
    expect(html).toContain("Dónde trabaja Jack en Hollywood, FL");
    expect(html).toMatch(
      /<a[^>]*href="\/es\/fort-lauderdale\/house-cleaning"[^>]*>Fort Lauderdale, FL<\/a>/,
    );
    expect(hrefs(html)).toContain("/es/hollywood/painting");
    const switches = [...html.matchAll(/<a[^>]*hrefLang="(en|es)"[^>]*>/g)].map((m) => [
      m[1],
      /href="([^"]+)"/.exec(m[0])?.[1],
    ]);
    expect(switches.length).toBeGreaterThanOrEqual(4);
    for (const [language, href] of switches) {
      expect(href, language).toBe(
        language === "en" ? "/hollywood/house-cleaning" : "/es/hollywood/house-cleaning",
      );
    }
  });

  it("links its header and hero to sections that exist", async () => {
    const html = await page("en", "hollywood", "painting");
    const anchors = new Set([...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]));

    expect(anchors).toEqual(new Set(["content", "ask", "areas"]));
    for (const anchor of anchors) expect(html, anchor).toContain(`id="${anchor}"`);
  });

  it("is linked from the service's page, one link per served city", async () => {
    const html = decoded(
      renderToStaticMarkup(await ServicePage({ locale: "en", slug: "painting" })),
    );

    expect(html).toMatch(
      /<a[^>]*href="\/fort-lauderdale\/painting"[^>]*>.*Fort Lauderdale, FL<\/a>/s,
    );
    expect(html).toMatch(/<a[^>]*href="\/hollywood\/painting"[^>]*>.*Hollywood, FL<\/a>/s);
  });

  it.each([
    ["an unknown city", "miami", "painting"],
    ["a city without an active ZIP", "stuart", "painting"],
    ["an unknown service", "hollywood", "handyman"],
    ["a city in capitals", "Hollywood", "painting"],
    ["a reserved first segment", "admin", "painting"],
  ])("is a 404 for %s", async (_case, city, slug) => {
    const quiet = { ...TREASURE_COAST, cities: [{ ...TREASURE_COAST.cities[0], zips: [] }] };
    serve([CLEANING, PAINTING], [SOUTH_FLORIDA, quiet]);

    await expect(ServicePage({ locale: "en", slug, city })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(serviceMetadata("en", slug, city)).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("throws, never a 404 or an empty page, when the API cannot answer", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(
      ServicePage({ locale: "en", slug: "painting", city: "hollywood" }),
    ).rejects.toBeInstanceOf(CatalogUnavailableError);
  });

  const absent: Record<Locale, RegExp> = {
    en: /\$|%|(?<!fixed-)price|\bfees?\b|review|rating|\bstars?\b|\bfree\b|licens|insur|guarant|warrant|escrow|refund|\d+\s*(pros|jobs|customers)/i,
    es: /\$|%|precio(?! fijo)|tarifa|reseña|calificaci|estrellas|gratis|licencia|asegurad|garant|reembols|\d+\s*(profesionales|trabajos|clientes)/i,
  };

  it.each(["en", "es"] as const)(
    "in %s shows no price, count, review or legal promise",
    async (locale) => {
      const text = (await page(locale, "fort-lauderdale", "house-cleaning"))
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ");
      const hit = absent[locale].exec(text);
      expect(hit && text.slice(Math.max(0, hit.index - 50), hit.index + 30)).toBeNull();
    },
  );
});

describe("a city page's metadata", () => {
  it("titles and describes the service in the city, with its canonical and its /es twin", async () => {
    vi.stubEnv("SITE_URL", "https://jackfixit.example");

    const en = await serviceMetadata("en", "painting", "fort-lauderdale");
    const es = await serviceMetadata("es", "painting", "fort-lauderdale");

    expect(en.title).toBe("Painting in Fort Lauderdale, FL | Jack Fix It");
    expect(en.description).toBe(
      "Painting in Fort Lauderdale, FL: tell Jack about the job, compare fixed-price quotes from pros near you and follow it in the app.",
    );
    expect(en.alternates).toEqual({
      canonical: "/fort-lauderdale/painting",
      languages: {
        en: "/fort-lauderdale/painting",
        es: "/es/fort-lauderdale/painting",
        "x-default": "/fort-lauderdale/painting",
      },
    });
    expect(es.title).toBe("Pintura en Fort Lauderdale, FL | Jack Fix It");
    expect(es.alternates?.canonical).toBe("/es/fort-lauderdale/painting");
  });

  it("keeps the description short enough for a results page with the longest shipped names", async () => {
    const lawn: Category = {
      ...POOLS,
      slug: "lawn-landscaping",
      names: { en: "Lawn & Landscaping", es: "Jardinería y paisajismo" },
    };
    const deerfield: Region = {
      region: "South Florida",
      cities: [{ ...SOUTH_FLORIDA.cities[0], city: "Deerfield Beach" }],
    };
    serve([lawn], [deerfield]);

    for (const locale of ["en", "es"] as const) {
      const { description } = await serviceMetadata(locale, "lawn-landscaping", "deerfield-beach");
      expect(String(description).length, locale).toBeLessThanOrEqual(160);
    }
  });
});

describe("the city routes", () => {
  it("are made on first visit and kept as long as the catalog read, in both languages", () => {
    for (const route of [enRoute, esRoute]) {
      expect(route.revalidate).toBe(CATALOG_REVALIDATE_SECONDS);
      expect(route.generateStaticParams()).toEqual([]);
    }
  });

  it("read the city from the first segment and the service from the second", async () => {
    const params = Promise.resolve({ slug: "hollywood", service: "painting" });

    expect((await enRoute.default({ params })).props).toEqual({
      locale: "en",
      slug: "painting",
      city: "hollywood",
    });
    expect((await esRoute.default({ params })).props).toEqual({
      locale: "es",
      slug: "painting",
      city: "hollywood",
    });
    expect((await esRoute.generateMetadata({ params })).title).toBe(
      "Pintura en Hollywood, FL | Jack Fix It",
    );
  });
});
