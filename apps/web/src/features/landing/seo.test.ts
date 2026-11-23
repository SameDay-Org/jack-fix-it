import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as englishImage from "@/app/(marketing)/opengraph-image";
import * as spanishImage from "@/app/(marketing)/es/opengraph-image";
import * as showcaseImage from "@/app/(showcase)/app/opengraph-image";
import * as spanishShowcaseImage from "@/app/(showcase)/es/app/opengraph-image";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { CatalogUnavailableError } from "@/features/seo/catalog";
import { CLEANING, PAINTING, SOUTH_FLORIDA, catalogFetch } from "@/features/seo/seo-test-helpers";
import { legalMetadata, showcaseMetadata } from "@/features/showcase/metadata";
import { PRIVACY_PATHS, TERMS_PATHS } from "@/features/site/routes";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

import { organizationJsonLd } from "./json-ld";
import { LandingPage } from "./landing-page";
import { landingMetadata } from "./metadata";

const SITE = "https://johngotit.com";

beforeEach(() => {
  vi.stubEnv("SITE_URL", "");
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed")));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the sitemap", () => {
  /** The API's catalog: two services, two served cities (seo-test-helpers.ts). */
  const serveCatalog = () =>
    vi.stubGlobal("fetch", vi.fn(catalogFetch([CLEANING, PAINTING], [SOUTH_FLORIDA])));

  it("lists no address without SITE_URL", async () => {
    expect(await sitemap()).toEqual([]);
  });

  it("lists the indexable public pages in both languages, each with its twin", async () => {
    vi.stubEnv("SITE_URL", SITE);
    serveCatalog();
    const entries = await sitemap();
    expect(entries.slice(0, 6).map((entry) => entry.url)).toEqual(
      ["/", "/es", "/app", "/es/app", "/for-pros", "/es/for-pros"].map(
        (path) => new URL(path, SITE).href,
      ),
    );
    expect(entries[1]?.alternates?.languages).toEqual({ en: `${SITE}/`, es: `${SITE}/es` });
    expect(entries[2]?.alternates?.languages).toEqual({ en: `${SITE}/app`, es: `${SITE}/es/app` });
    expect(entries[5]?.alternates?.languages).toEqual({
      en: `${SITE}/for-pros`,
      es: `${SITE}/es/for-pros`,
    });
  });

  it("lists every active service, and every active service in each served city (#87)", async () => {
    vi.stubEnv("SITE_URL", SITE);
    serveCatalog();
    const entries = await sitemap();
    const paths = entries.slice(6).map((entry) => new URL(entry.url).pathname);

    expect(paths).toEqual([
      "/house-cleaning",
      "/es/house-cleaning",
      "/painting",
      "/es/painting",
      "/fort-lauderdale/house-cleaning",
      "/es/fort-lauderdale/house-cleaning",
      "/fort-lauderdale/painting",
      "/es/fort-lauderdale/painting",
      "/hollywood/house-cleaning",
      "/es/hollywood/house-cleaning",
      "/hollywood/painting",
      "/es/hollywood/painting",
    ]);
    expect(entries.find((e) => e.url === `${SITE}/es/hollywood/painting`)?.alternates).toEqual({
      languages: { en: `${SITE}/hollywood/painting`, es: `${SITE}/es/hollywood/painting` },
    });
  });

  it("throws, as the pages do, when the catalog cannot be read", async () => {
    vi.stubEnv("SITE_URL", SITE);

    await expect(sitemap()).rejects.toBeInstanceOf(CatalogUnavailableError);
  });

  it("leaves out the legal pages while they are noindex placeholders", async () => {
    vi.stubEnv("SITE_URL", SITE);
    serveCatalog();
    const urls = (await sitemap()).map((entry) => entry.url);
    for (const locale of ["en", "es"] as const) {
      for (const document of ["terms", "privacy"] as const) {
        expect((await legalMetadata(locale, document)).robots).toMatchObject({ index: false });
        const path = (document === "terms" ? TERMS_PATHS : PRIVACY_PATHS)[locale];
        expect(urls).not.toContain(new URL(path, SITE).href);
      }
    }
  });
});

describe("robots.txt", () => {
  it("names the sitemap in production when the site's address is known", () => {
    vi.stubEnv("SITE_URL", SITE);
    expect(robots()).toEqual({
      rules: { userAgent: "*", allow: "/", disallow: "/admin" },
      sitemap: `${SITE}/sitemap.xml`,
    });
  });

  it("is otherwise unchanged: no sitemap without SITE_URL, nothing indexable outside production", () => {
    expect(robots()).toEqual({ rules: { userAgent: "*", allow: "/", disallow: "/admin" } });
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("SITE_URL", SITE);
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
  });
});

describe("the structured data", () => {
  it("is an Organization with its name, address and logo, and nothing that does not exist", () => {
    vi.stubEnv("SITE_URL", SITE);
    const data = JSON.parse(organizationJsonLd("John Got It") ?? "{}") as Record<string, unknown>;
    expect(data).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "John Got It",
      url: `${SITE}/`,
      logo: `${SITE}/icon.svg`,
    });
  });

  it("cannot close its script, and is left out without SITE_URL", () => {
    vi.stubEnv("SITE_URL", SITE);
    expect(organizationJsonLd("</script><script>alert(1)</script>")).not.toContain("<");
    vi.stubEnv("SITE_URL", "");
    expect(organizationJsonLd("John Got It")).toBeNull();
  });

  it("is on the landing page only when the site's address is known", async () => {
    const without = renderToStaticMarkup(await LandingPage({ locale: "en" }));
    expect(without).not.toContain("application/ld+json");
    vi.stubEnv("SITE_URL", SITE);
    const html = renderToStaticMarkup(await LandingPage({ locale: "en" }));
    expect(html).toContain('<script type="application/ld+json">{"@context":"https://schema.org"');
    expect(html.match(/application\/ld\+json/g)).toHaveLength(1);
  });
});

describe("the link cards", () => {
  it.each([
    ["en", englishImage, en.landing.meta.ogAlt],
    ["es", spanishImage, es.landing.meta.ogAlt],
    // The app's page (/app, /es/app) has its own card too (#461).
    ["en", showcaseImage, en.showcase.meta.ogAlt],
    ["es", spanishShowcaseImage, es.showcase.meta.ogAlt],
  ] as const)("in %s is a 1200 x 630 PNG described in its language", (_, image, alt) => {
    expect(image.alt).toBe(alt);
    expect(image.size).toEqual({ width: 1200, height: 630 });
    expect(image.contentType).toBe("image/png");
  });

  it.each(["en", "es"] as const)("in %s asks X for a large card", async (locale) => {
    for (const metadata of [await landingMetadata(locale), await showcaseMetadata(locale)]) {
      expect(metadata.twitter).toMatchObject({
        card: "summary_large_image",
        title: metadata.title,
      });
    }
  });

  it.each([
    ["en", showcaseImage, en.showcase.hero.lead],
    ["es", spanishShowcaseImage, es.showcase.hero.lead],
  ] as const)(
    "in %s draws the app page's card with the page's own line (#461)",
    (_, image, line) => {
      expect(image.alt).toContain(line);
      expect(typeof image.default).toBe("function");
    },
  );
});
