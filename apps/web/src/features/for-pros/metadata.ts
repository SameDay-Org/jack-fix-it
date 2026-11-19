import type { Metadata } from "next";

import { localizedMetadata } from "@/features/site/metadata";
import { FOR_PROS_PATHS } from "@/features/site/routes";
import type { Locale } from "@/i18n/config";
import { getT } from "@/i18n/server";

/** The page for professionals' metadata in one language (features/site/metadata.ts). */
export async function forProsMetadata(locale: Locale): Promise<Metadata> {
  const t = await getT(locale);
  const title = t("forPros.meta.title");
  const description = t("forPros.meta.description");
  return {
    ...localizedMetadata({
      locale,
      paths: FOR_PROS_PATHS,
      title,
      description,
      siteName: t("brand.name"),
    }),
    // A large card on X; its image is the page's Open Graph image (opengraph-image.tsx).
    twitter: { card: "summary_large_image", title, description },
  };
}
