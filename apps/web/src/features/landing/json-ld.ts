import { siteUrl } from "@/features/site/routes";

/**
 * The landing's structured data: an `Organization` with its name, its address on the web and
 * its logo (the site's icon), only when SITE_URL is set (they must be absolute). Nothing else:
 * no rating, no review, no street address or phone, none of which exists. Returned as the text
 * of a JSON-LD script, with `<` escaped so it cannot close the script.
 */
export function organizationJsonLd(name: string): string | null {
  const base = siteUrl();
  if (!base) return null;
  const data = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name,
    url: new URL("/", base).href,
    logo: new URL("/icon.svg", base).href,
  };
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
