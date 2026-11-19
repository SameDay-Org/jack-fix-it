import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ImageResponse } from "next/og";

import { landingOgImage } from "@/features/landing/og-image";
import { localizedMetadata } from "@/features/site/metadata";
import type { Locale } from "@/i18n/config";
import { getT } from "@/i18n/server";

import { findService, loadCatalog, localized, servedPlace, servicePaths } from "./catalog";
import { serviceTitle } from "./service-page";

/** The service and its place, or a 404 (the same rule as the page). */
async function serviceOf(slug: string) {
  const catalog = await loadCatalog();
  const category = findService(catalog, slug);
  if (!category) notFound();
  return { category, place: servedPlace(catalog) };
}

/**
 * A service page's metadata in one language: "House Cleaning in South Florida | Jack Fix It",
 * a description of what the reader can do, the canonical and its `/es` twin (features/site).
 */
export async function serviceMetadata(locale: Locale, slug: string): Promise<Metadata> {
  const { category, place } = await serviceOf(slug);
  const t = await getT(locale);
  const name = localized(category.names, locale, category.slug);
  const title = place
    ? t("seo.service.meta.title", { name, place })
    : t("seo.service.meta.titleAnywhere", { name });
  const description = place
    ? t("seo.service.meta.description", { name, place })
    : t("seo.service.meta.descriptionAnywhere", { name });
  return {
    ...localizedMetadata({
      locale,
      paths: servicePaths(category.slug),
      title,
      description,
      siteName: t("brand.name"),
    }),
    // A large card on X; its image is the page's Open Graph image (opengraph-image.tsx).
    twitter: { card: "summary_large_image", title, description },
  };
}

/** A service page's Open Graph card: the landing's card with the page's headline. */
export async function serviceOgImage(locale: Locale, slug: string): Promise<ImageResponse> {
  const { category, place } = await serviceOf(slug);
  const t = await getT(locale);
  return landingOgImage(
    locale,
    serviceTitle(t, localized(category.names, locale, category.slug), place),
  );
}
