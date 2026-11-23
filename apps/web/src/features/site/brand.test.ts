import type { Metadata } from "next";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Locale } from "@/i18n/config";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
// next/font runs in Next's compiler only: here a class name stands in for the site's font.
vi.mock("next/font/local", () => ({ default: () => ({ className: "site-font" }) }));

import NotFound, { generateMetadata as notFoundMetadata } from "@/app/not-found";
import { forProsMetadata } from "@/features/for-pros/metadata";
import { ForProsPage } from "@/features/for-pros/for-pros-page";
import { LandingPage } from "@/features/landing/landing-page";
import { landingMetadata } from "@/features/landing/metadata";
import { requestMetadata } from "@/features/request-flow/metadata";
import { serviceMetadata } from "@/features/seo/metadata";
import { CLEANING, PAINTING, SOUTH_FLORIDA, catalogFetch } from "@/features/seo/seo-test-helpers";
import { ServicePage } from "@/features/seo/service-page";
import { LegalPlaceholder } from "@/features/showcase/legal-placeholder";
import { legalMetadata, showcaseMetadata } from "@/features/showcase/metadata";
import { ShowcasePage } from "@/features/showcase/showcase-page";

/**
 * The brand's name and its persona before the rename (#602), in any visible text. Case counts:
 * the brand's line ("we fix it.") stays.
 */
const OLD_NAME = /\bJack\b|Fix It|jackfixit|jack-fix-it/;
const NEW_NAME = "John Got It";
const CATALOGS = { en, es } as const;
const LOCALES = ["en", "es"] as const;

beforeEach(() => {
  vi.stubEnv("SITE_URL", "https://johngotit.com");
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("CONTACT_EMAIL", "");
  vi.stubEnv("REQUEST_FLOW_ENABLED", "true");
  vi.stubGlobal("fetch", vi.fn(catalogFetch([CLEANING, PAINTING], [SOUTH_FLORIDA])));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function decoded(html: string): string {
  return html
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** Every string of a catalog, with the key that holds it. */
function entries(value: unknown, key = ""): [string, string][] {
  if (typeof value === "string") return [[key, value]];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => entries(v, key ? `${key}.${k}` : k));
}

/** The public pages a visitor reaches, in one language, as the server renders them. */
async function pages(locale: Locale): Promise<[string, string][]> {
  return [
    ["landing", renderToStaticMarkup(await LandingPage({ locale }))],
    ["showcase", renderToStaticMarkup(await ShowcasePage({ locale }))],
    ["for pros", renderToStaticMarkup(await ForProsPage({ locale }))],
    ["service", renderToStaticMarkup(await ServicePage({ locale, slug: "house-cleaning" }))],
    [
      "city",
      renderToStaticMarkup(
        await ServicePage({ locale, slug: "painting", city: "fort-lauderdale" }),
      ),
    ],
    ["terms", renderToStaticMarkup(await LegalPlaceholder({ locale, document: "terms" }))],
    ["privacy", renderToStaticMarkup(await LegalPlaceholder({ locale, document: "privacy" }))],
  ].map(([name, html]) => [name, decoded(html)]);
}

/** Every page's metadata in one language. */
async function metadataOf(locale: Locale): Promise<[string, Metadata][]> {
  return [
    ["landing", await landingMetadata(locale)],
    ["showcase", await showcaseMetadata(locale)],
    ["for pros", await forProsMetadata(locale)],
    ["request", await requestMetadata(locale)],
    ["service", await serviceMetadata(locale, "house-cleaning")],
    ["city", await serviceMetadata(locale, "painting", "fort-lauderdale")],
    ["terms", await legalMetadata(locale, "terms")],
    ["privacy", await legalMetadata(locale, "privacy")],
  ];
}

describe("the brand (#602)", () => {
  it.each(LOCALES)("no visible copy contains the old name: the %s catalog", (locale) => {
    const stale = entries(CATALOGS[locale]).filter(([, text]) => OLD_NAME.test(text));
    expect(stale).toEqual([]);
    expect(CATALOGS[locale].brand.name).toBe(NEW_NAME);
  });

  it.each(LOCALES)("no visible copy contains the old name: the %s pages", async (locale) => {
    for (const [name, html] of await pages(locale)) {
      expect(html, name).not.toMatch(OLD_NAME);
      expect(html, name).toContain("John");
    }
    const notFound = decoded(renderToStaticMarkup(await NotFound()));
    expect(notFound).not.toMatch(OLD_NAME);
  });

  it.each(LOCALES)("metadata title and description use the new name in %s", async (locale) => {
    for (const [name, metadata] of await metadataOf(locale)) {
      expect(JSON.stringify(metadata), name).not.toMatch(OLD_NAME);
      expect(String(metadata.title), name).toContain(NEW_NAME);
      if (metadata.description) expect(metadata.description, name).toMatch(/\bJohn\b/);
      if (metadata.openGraph)
        expect(metadata.openGraph, name).toMatchObject({ siteName: NEW_NAME });
    }
    const notFound = await notFoundMetadata();
    expect(String(notFound.title)).toBe(
      "Page not found | John Got It · Página no encontrada | John Got It",
    );
  });

  it("names the landing in its title and Open Graph card, in both languages", async () => {
    const english = await landingMetadata("en");
    const spanish = await landingMetadata("es");

    expect(english.title).toBe("John Got It · Whatever happens at home, we fix it.");
    expect(english.description).toBe(
      "Tell John what's going on at home, compare fixed-price quotes from pros near you and follow the job in the app.",
    );
    expect(spanish.title).toBe("John Got It · Pase lo que pase en casa, lo arreglamos.");
    expect(english.openGraph).toMatchObject({ siteName: NEW_NAME, url: "/" });
    expect(String(english.metadataBase)).toBe("https://johngotit.com/");
  });

  it.each([
    ["en", "terms", "Terms of Service", "Our Terms of Service will be published here."],
    ["en", "privacy", "Privacy Policy", "Our Privacy Policy will be published here."],
    ["es", "terms", "Términos de servicio", "Aquí publicaremos nuestros Términos de servicio."],
    [
      "es",
      "privacy",
      "Política de privacidad",
      "Aquí publicaremos nuestra Política de privacidad.",
    ],
  ] as const)(
    "legal pages show the new brand and the placeholder notice unchanged: %s %s",
    async (locale, document, title, lead) => {
      const html = decoded(renderToStaticMarkup(await LegalPlaceholder({ locale, document })));

      expect(html).toContain('John<span class="text-green-500"> Got It</span>');
      expect(html).toMatch(new RegExp(`<h1[^>]*>${title}</h1>`));
      expect(html).toContain(lead);
      expect(html).not.toMatch(OLD_NAME);
      expect((await legalMetadata(locale, document)).title).toBe(`${title} · ${NEW_NAME}`);
    },
  );
});
