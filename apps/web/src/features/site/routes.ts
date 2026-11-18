import type { Locale } from "@/i18n/config";

/**
 * The site's public pages, in each language. English has no prefix; Spanish lives under `/es`.
 * The landing (#85) sells the service; the showcase (#403) shows the app.
 */
export const LANDING_PATHS: Record<Locale, string> = { en: "/", es: "/es" };
export const SHOWCASE_PATHS: Record<Locale, string> = { en: "/app", es: "/es/app" };

/** The legal pages the footer links to: placeholders until the texts are approved (#10). */
export const TERMS_PATHS: Record<Locale, string> = { en: "/terms", es: "/es/terms" };
export const PRIVACY_PATHS: Record<Locale, string> = { en: "/privacy", es: "/es/privacy" };

/**
 * This site's public origin, from SITE_URL (https, no path), or null when it is not set or
 * is not an http(s) origin. Canonical, hreflang and Open Graph URLs must be absolute, so
 * without it the pages carry none: a missing tag, never a wrong address.
 */
export function siteUrl(): URL | null {
  const value = process.env.SITE_URL;
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return new URL(url.origin);
}
