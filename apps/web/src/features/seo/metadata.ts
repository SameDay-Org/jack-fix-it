import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ImageResponse } from "next/og";

import { landingOgImage } from "@/features/landing/og-image";
import { localizedMetadata } from "@/features/site/metadata";
import type { Locale } from "@/i18n/config";
import { getT } from "@/i18n/server";

import {
  cityLabel,
  cityServicePaths,
  loadCatalog,
  localized,
  servedPlace,
  servicePaths,
} from "./catalog";
import { cityServiceTitle, pageSubject, serviceTitle } from "./service-page";

/** The page's service, its city (on a city's page) and the served region, or a 404. */
async function subjectOf(slug: string, city?: string) {
  const catalog = await loadCatalog();
  const subject = pageSubject(catalog, slug, city);
  if (!subject) notFound();
  return { ...subject, place: servedPlace(catalog) };
}

/**
 * A service page's metadata in one language: "House Cleaning in South Florida | John Got It",
 * or "Handyman in Fort Lauderdale, FL | John Got It" for one city, a description of what the
 * reader can do, the canonical and its `/es` twin (features/site).
 */
export async function serviceMetadata(
  locale: Locale,
  slug: string,
  citySlug?: string,
): Promise<Metadata> {
  const { category, city, place } = await subjectOf(slug, citySlug);
  const t = await getT(locale);
  const name = localized(category.names, locale, category.slug);
  let title: string;
  let description: string;
  if (city) {
    title = t("seo.city.meta.title", { name, city: cityLabel(city) });
    description = t("seo.city.meta.description", { name, city: cityLabel(city) });
  } else if (place) {
    title = t("seo.service.meta.title", { name, place });
    description = t("seo.service.meta.description", { name, place });
  } else {
    title = t("seo.service.meta.titleAnywhere", { name });
    description = t("seo.service.meta.descriptionAnywhere", { name });
  }
  return {
    ...localizedMetadata({
      locale,
      paths: city ? cityServicePaths(city.slug, category.slug) : servicePaths(category.slug),
      title,
      description,
      siteName: t("brand.name"),
    }),
    // A large card on X; its image is the page's Open Graph image (opengraph-image.tsx).
    twitter: { card: "summary_large_image", title, description },
  };
}

/** A service page's Open Graph card: the landing's card with the page's headline. */
export async function serviceOgImage(
  locale: Locale,
  slug: string,
  citySlug?: string,
): Promise<ImageResponse> {
  const { category, city, place } = await subjectOf(slug, citySlug);
  const t = await getT(locale);
  const name = localized(category.names, locale, category.slug);
  return landingOgImage(
    locale,
    city ? cityServiceTitle(t, name, city) : serviceTitle(t, name, place),
  );
}
