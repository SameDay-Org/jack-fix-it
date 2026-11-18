import type { Metadata } from "next";

import { localizedMetadata } from "@/features/site/metadata";
import { LANDING_PATHS } from "@/features/site/routes";
import type { Locale } from "@/i18n/config";
import { getT } from "@/i18n/server";

/** The landing page's metadata in one language (features/site/metadata.ts). */
export async function landingMetadata(locale: Locale): Promise<Metadata> {
  const t = await getT(locale);
  const title = t("landing.meta.title");
  const description = t("landing.meta.description");
  return {
    ...localizedMetadata({
      locale,
      paths: LANDING_PATHS,
      title,
      description,
      siteName: t("brand.name"),
    }),
    // A large card on X; its image is the page's Open Graph image (opengraph-image.tsx).
    twitter: { card: "summary_large_image", title, description },
  };
}
