import type { components } from "@jack/shared";
import { cache } from "react";

import type { Locale } from "@/i18n/config";
import { apiGet } from "@/lib/api";

export type Category = components["schemas"]["CategoryOut"];
export type Region = components["schemas"]["RegionOut"];
export type IntakeQuestion = Category["intake_questions"][number];

/** The active categories and the served areas (region → city → ZIPs), as the public API lists them. */
export type Catalog = { categories: Category[]; regions: Region[] };

/**
 * How long one read of the catalog is kept: an hour, as the landing's categories. The routes
 * repeat it as a literal (`revalidate = 3600`): Next reads that before running any code.
 */
export const CATALOG_REVALIDATE_SECONDS = 3600;

/** The data cache's tag for the catalog: one call to `revalidateTag` refreshes every page. */
export const CATALOG_TAG = "catalog";

/** A slug a page address can carry: lowercase words joined by single hyphens. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Paths the site already answers or owns at its root and under `/es`: the routes (src/app,
 * route groups left out), the folders and files it serves from `public` (`/showcase/…`), and
 * the names Next gives its metadata routes. A category or a city with one of these slugs gets no
 * page and no link: it would be hidden by a static route (static routes win over `/[slug]`), or
 * it would claim a namespace the site keeps for its own files. catalog.test.ts keeps this list
 * in step with src/app and public.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin",
  "api",
  "app",
  "es",
  "for-pros",
  "mascot",
  "privacy",
  "request",
  "showcase",
  "terms",
  "icon",
  "apple-icon",
  "favicon",
  "manifest",
  "robots",
  "sitemap",
  "opengraph-image",
  "twitter-image",
]);

/** Next adds a hash to a generated image's path (`/opengraph-image-1pnh59`). */
const RESERVED_PREFIXES = ["opengraph-image-", "twitter-image-", "icon-", "apple-icon-"];

/** Whether a page may live at `/<slug>`: a well-formed slug no other route already answers. */
export function isPageSlug(slug: string): boolean {
  return (
    SLUG.test(slug) &&
    !RESERVED_SLUGS.has(slug) &&
    !RESERVED_PREFIXES.some((prefix) => slug.startsWith(prefix))
  );
}

/** The API could not give the catalog: the page fails rather than show something made up. */
export class CatalogUnavailableError extends Error {
  constructor() {
    super("The catalog could not be read from the API.");
    this.name = "CatalogUnavailableError";
  }
}

/** Both reads go through Next's data cache, shared by every page, under one tag. */
const CACHED = { next: { revalidate: CATALOG_REVALIDATE_SECONDS, tags: [CATALOG_TAG] } };

/**
 * The catalog, read once for the whole site. The public catalog routes allow a few calls a
 * minute per address and the web server is a single address, so a crawl must not read the API
 * once per page: Next's data cache keeps each answer for an hour for every page (it keeps only
 * a 200: an error is never stored), and `cache` shares the read within one render (metadata,
 * page and image).
 *
 * When the API cannot answer, this throws CatalogUnavailableError: a first visit gets Next's
 * error page (not cached, so the next visit tries again), and an hourly refresh that fails
 * keeps the last good page. Nothing is made up in between.
 */
export const loadCatalog = cache(async (): Promise<Catalog> => {
  try {
    const [categories, regions] = await Promise.all([
      apiGet("/v1/categories", CACHED),
      apiGet("/v1/service-areas", CACHED),
    ]);
    return { categories, regions };
  } catch {
    throw new CatalogUnavailableError();
  }
});

/** The cities with at least one active ZIP, region by region, in the API's order. */
export function servedRegions(catalog: Catalog): Region[] {
  return catalog.regions
    .map((region) => ({ ...region, cities: region.cities.filter((city) => city.zips.length > 0) }))
    .filter((region) => region.cities.length > 0);
}

/**
 * The categories that get a page (#87, the Foreman's D1): active (the API lists no other), with
 * a slug a page can carry (the first one wins if two share it), and offered somewhere, i.e. at
 * least one city has an active ZIP. In the API's order.
 */
export function serviceCategories(catalog: Catalog): Category[] {
  if (servedRegions(catalog).length === 0) return [];
  const seen = new Set<string>();
  return catalog.categories.filter((category) => {
    if (!isPageSlug(category.slug) || seen.has(category.slug)) return false;
    seen.add(category.slug);
    return true;
  });
}

/** The category with a page at `/<slug>`, or null (not active, not served, or reserved). */
export function findService(catalog: Catalog, slug: string): Category | null {
  return serviceCategories(catalog).find((category) => category.slug === slug) ?? null;
}

/** A text the API gives per language: the reader's, else English, else the fallback. */
export function localized(
  texts: Record<string, string> | null | undefined,
  locale: Locale,
  fallback: string,
): string {
  return texts?.[locale]?.trim() || texts?.en?.trim() || fallback;
}

/** A service page's address in each language: the same slug under `/es` (the Foreman's D2). */
export function servicePaths(slug: string): Record<Locale, string> {
  return { en: `/${slug}`, es: `/es/${slug}` };
}

/** The one region served, by name, or null when there are several (the title names none). */
export function servedPlace(catalog: Catalog): string | null {
  const regions = servedRegions(catalog);
  return regions.length === 1 ? regions[0].region : null;
}

/** A served city as its page knows it: its slug, its name as stored (D3) and its ZIPs. */
export type ServedCity = {
  slug: string;
  city: string;
  state: string;
  region: string;
  zips: string[];
};

/** Lowercase ASCII words joined by hyphens: "Fort Lauderdale" → "fort-lauderdale". */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The cities with at least one active ZIP, in the API's order, each with a slug: its name, or
 * its name and state when two served cities would share a slug (a Springfield in two states).
 * A city whose slug is reserved or empty gets no page (catalog.ts, RESERVED_SLUGS).
 */
export function servedCities(catalog: Catalog): ServedCity[] {
  const cities = servedRegions(catalog).flatMap((region) =>
    region.cities.map((city) => ({
      city: city.city,
      state: city.state,
      region: region.region,
      zips: city.zips.map((zip) => zip.zip_code),
    })),
  );
  const count = new Map<string, number>();
  for (const { city } of cities) count.set(slugify(city), (count.get(slugify(city)) ?? 0) + 1);
  const seen = new Set<string>();
  return cities
    .map((city) => ({
      ...city,
      slug:
        (count.get(slugify(city.city)) ?? 0) > 1
          ? slugify(`${city.city} ${city.state}`)
          : slugify(city.city),
    }))
    .filter(({ slug }) => {
      if (!isPageSlug(slug) || seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
}

/** "Fort Lauderdale, FL": a city as the pages name it. */
export function cityLabel(city: ServedCity): string {
  return `${city.city}, ${city.state}`;
}

/**
 * The service and the city of `/<city>/<service>` (the Foreman's D1: an active category and a
 * city with an active ZIP), or null.
 */
export function findCityService(
  catalog: Catalog,
  citySlug: string,
  serviceSlug: string,
): { city: ServedCity; category: Category } | null {
  const city = servedCities(catalog).find((served) => served.slug === citySlug);
  const category = findService(catalog, serviceSlug);
  return city && category ? { city, category } : null;
}

/** A city + service page's address in each language: the same slugs under `/es`. */
export function cityServicePaths(citySlug: string, serviceSlug: string): Record<Locale, string> {
  return { en: `/${citySlug}/${serviceSlug}`, es: `/es/${citySlug}/${serviceSlug}` };
}
