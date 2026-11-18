import type { Locale } from "@/i18n/config";
import { apiGet } from "@/lib/api";

/**
 * The categories the product ships (apps/api categories/seed_data.json; a test keeps the two
 * equal). Only shown when the API cannot be read: the page never makes one up.
 */
export const SHIPPED_CATEGORY_SLUGS = [
  "house-cleaning",
  "handyman",
  "painting",
  "lawn-landscaping",
  "moving-assembly",
] as const;

/** A category in the services grid; `name` is null when the page names it (the fallback). */
export type ServiceCategory = { slug: string; name: string | null };

/**
 * The active categories, from `GET /v1/categories`, read on the server. The landing's routes are
 * built once and refreshed every hour (their `revalidate`), so the API is read once an hour for
 * every visitor, not once each. When it cannot be read (at build time, or down), the shipped
 * list: a calm page, never an error.
 */
export async function loadCategories(locale: Locale): Promise<ServiceCategory[]> {
  try {
    const categories = await apiGet("/v1/categories");
    if (categories.length > 0) {
      return categories.map((category) => ({
        slug: category.slug,
        name: category.names[locale] ?? category.names.en ?? null,
      }));
    }
  } catch {
    // The API is not reachable here: the shipped list below.
  }
  return SHIPPED_CATEGORY_SLUGS.map((slug) => ({ slug, name: null }));
}

export type ShippedSlug = (typeof SHIPPED_CATEGORY_SLUGS)[number];

export function isShippedSlug(slug: string): slug is ShippedSlug {
  return (SHIPPED_CATEGORY_SLUGS as readonly string[]).includes(slug);
}
