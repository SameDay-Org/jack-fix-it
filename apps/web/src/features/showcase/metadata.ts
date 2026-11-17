import type { Metadata } from "next";

import { defaultLocale, type Locale } from "@/i18n/config";
import { getT } from "@/i18n/server";

import { SHOWCASE_PATHS, siteUrl } from "./routes";

/** Open Graph's name for each language of the page (the product serves the United States). */
const OG_LOCALES: Record<Locale, string> = { en: "en_US", es: "es_US" };

/**
 * The showcase page's metadata in one language: title, description and Open Graph texts,
 * always. With SITE_URL set it also names the page's own address (canonical) and its twin in
 * the other language (`hreflang`, with English as `x-default`); those must be absolute, so
 * without SITE_URL the page carries none of them rather than a guessed address.
 */
export async function showcaseMetadata(locale: Locale): Promise<Metadata> {
  const t = await getT(locale);
  const base = siteUrl();
  const title = t("showcase.meta.title");
  const description = t("showcase.meta.description");
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
            canonical: SHOWCASE_PATHS[locale],
            languages: { ...SHOWCASE_PATHS, "x-default": SHOWCASE_PATHS[defaultLocale] },
          },
        }
      : {}),
    openGraph: {
      type: "website",
      siteName: t("brand.name"),
      title,
      description,
      locale: OG_LOCALES[locale],
      alternateLocale: others,
      ...(base ? { url: SHOWCASE_PATHS[locale] } : {}),
    },
  };
}

/** A legal placeholder's metadata: its title, and no indexing while it holds no text. */
export async function legalMetadata(
  locale: Locale,
  document: "terms" | "privacy",
): Promise<Metadata> {
  const t = await getT(locale);
  return {
    title: `${t(`showcase.legal.${document}.title`)} · ${t("brand.name")}`,
    robots: { index: false, follow: true },
  };
}
