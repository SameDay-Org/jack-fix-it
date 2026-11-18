import type { MetadataRoute } from "next";

import {
  LANDING_PATHS,
  PRIVACY_PATHS,
  SHOWCASE_PATHS,
  siteUrl,
  TERMS_PATHS,
} from "@/features/site/routes";
import { locales } from "@/i18n/config";

/**
 * The public pages, each in English and Spanish with its twin as an alternate. Its addresses
 * must be absolute: without SITE_URL there is no sitemap entry rather than a guessed address.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  if (!base) return [];
  const at = (path: string) => new URL(path, base).href;
  return [LANDING_PATHS, SHOWCASE_PATHS, TERMS_PATHS, PRIVACY_PATHS].flatMap((paths) =>
    locales.map((locale) => ({
      url: at(paths[locale]),
      alternates: {
        languages: Object.fromEntries(locales.map((other) => [other, at(paths[other])])),
      },
    })),
  );
}
