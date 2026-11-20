import type { MetadataRoute } from "next";

import {
  cityServicePaths,
  loadCatalog,
  servedCities,
  serviceCategories,
  servicePaths,
} from "@/features/seo/catalog";
import { FOR_PROS_PATHS, LANDING_PATHS, SHOWCASE_PATHS, siteUrl } from "@/features/site/routes";
import { locales } from "@/i18n/config";

/**
 * Made on each request from the cached catalog (no API call per request: catalog.ts). It cannot
 * be made when the site is built: the API is not reachable then.
 */
export const dynamic = "force-dynamic";

/**
 * The public pages search engines may index, each in English and Spanish with its twin as an
 * alternate. Its addresses must be absolute: without SITE_URL there is no sitemap entry rather
 * than a guessed address.
 *
 * Besides the landing, the showcase and the page for professionals: a page per active service
 * and one per active service in each city with an active ZIP (#87, the Foreman's D1), from the
 * API's catalog. When the catalog cannot be read this throws, as the pages do (D4): an error,
 * not a sitemap that leaves them out.
 *
 * The terms and privacy pages are left out while they are `noindex` placeholders
 * (features/showcase/metadata.ts): a sitemap lists only indexable pages. They come back with the
 * legal text.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  if (!base) return [];
  const catalog = await loadCatalog();
  const services = serviceCategories(catalog);
  const pages = [
    LANDING_PATHS,
    SHOWCASE_PATHS,
    FOR_PROS_PATHS,
    ...services.map((service) => servicePaths(service.slug)),
    ...servedCities(catalog).flatMap((city) =>
      services.map((service) => cityServicePaths(city.slug, service.slug)),
    ),
  ];
  const at = (path: string) => new URL(path, base).href;
  return pages.flatMap((paths) =>
    locales.map((locale) => ({
      url: at(paths[locale]),
      alternates: {
        languages: Object.fromEntries(locales.map((other) => [other, at(paths[other])])),
      },
    })),
  );
}
