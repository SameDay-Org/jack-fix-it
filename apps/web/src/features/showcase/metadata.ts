import type { Metadata } from "next";

import { localizedMetadata } from "@/features/site/metadata";
import { SHOWCASE_PATHS } from "@/features/site/routes";
import type { Locale } from "@/i18n/config";
import { getT } from "@/i18n/server";

/**
 * The showcase page's metadata in one language (features/site/metadata.ts), with a large card
 * on X; its image is the page's Open Graph image (app/(showcase)/app/opengraph-image.tsx, #461).
 */
export async function showcaseMetadata(locale: Locale): Promise<Metadata> {
  const t = await getT(locale);
  const title = t("showcase.meta.title");
  const description = t("showcase.meta.description");
  return {
    ...localizedMetadata({
      locale,
      paths: SHOWCASE_PATHS,
      title,
      description,
      siteName: t("brand.name"),
    }),
    twitter: { card: "summary_large_image", title, description },
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
