import type { Metadata } from "next";

import { defaultLocale, type Locale } from "@/i18n/config";

import { siteUrl } from "./routes";

/** Open Graph's name for each language of a page (the product serves the United States). */
const OG_LOCALES: Record<Locale, string> = { en: "en_US", es: "es_US" };

/**
 * A public page's metadata in one language: title, description and Open Graph texts, always.
 * With SITE_URL set it also names the page's own address (canonical) and its twin in the other
 * language (`hreflang`, with English as `x-default`); those must be absolute, so without
 * SITE_URL the page carries none of them rather than a guessed address.
 */
export function localizedMetadata(page: {
  locale: Locale;
  /** The page's address in each language. */
  paths: Record<Locale, string>;
  title: string;
  description: string;
  siteName: string;
}): Metadata {
  const { locale, paths, title, description, siteName } = page;
  const base = siteUrl();
  const others = Object.entries(OG_LOCALES)
    .filter(([value]) => value !== locale)
    .map(([, name]) => name);

  return {
    title,
    description,
    ...(base
      ? {
          metadataBase: base,
          alternates: {
            canonical: paths[locale],
            languages: { ...paths, "x-default": paths[defaultLocale] },
          },
        }
      : {}),
    openGraph: {
      type: "website",
      siteName,
      title,
      description,
      locale: OG_LOCALES[locale],
      alternateLocale: others,
      ...(base ? { url: paths[locale] } : {}),
    },
  };
}
