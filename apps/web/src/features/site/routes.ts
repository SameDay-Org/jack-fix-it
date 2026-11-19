import type { Locale } from "@/i18n/config";

/**
 * The site's public pages, in each language. English has no prefix; Spanish lives under `/es`.
 * The landing (#85) sells the service; the showcase (#403) shows the app.
 */
export const LANDING_PATHS: Record<Locale, string> = { en: "/", es: "/es" };
export const SHOWCASE_PATHS: Record<Locale, string> = { en: "/app", es: "/es/app" };
/** The page for professionals (#88): how pros get work, what we ask of them. */
export const FOR_PROS_PATHS: Record<Locale, string> = { en: "/for-pros", es: "/es/for-pros" };
/** The web request flow (#86): no account needed. Not indexed, never cached. */
export const REQUEST_PATHS: Record<Locale, string> = { en: "/request", es: "/es/request" };

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

/** A public page's language from its path (query ignored): Spanish under `/es`, else English. */
export function localeOfPath(path: string): Locale {
  const pathname = path.split(/[?#]/)[0];
  return pathname === "/es" || pathname.startsWith("/es/") ? "es" : "en";
}
