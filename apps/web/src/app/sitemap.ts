import type { MetadataRoute } from "next";

import { FOR_PROS_PATHS, LANDING_PATHS, SHOWCASE_PATHS, siteUrl } from "@/features/site/routes";
import { locales } from "@/i18n/config";

/**
 * The public pages search engines may index, each in English and Spanish with its twin as an
 * alternate. Its addresses must be absolute: without SITE_URL there is no sitemap entry rather
 * than a guessed address.
 *
 * The terms and privacy pages are left out while they are `noindex` placeholders
 * (features/showcase/metadata.ts): a sitemap lists only indexable pages. They come back with the
 * legal text.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  if (!base) return [];
  const at = (path: string) => new URL(path, base).href;
  return [LANDING_PATHS, SHOWCASE_PATHS, FOR_PROS_PATHS].flatMap((paths) =>
    locales.map((locale) => ({
      url: at(paths[locale]),
      alternates: {
        languages: Object.fromEntries(locales.map((other) => [other, at(paths[other])])),
      },
    })),
  );
}
