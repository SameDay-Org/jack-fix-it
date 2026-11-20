import type { Metadata } from "next";

import type { Locale } from "@/i18n/config";
import { getT } from "@/i18n/server";

/**
 * The request flow's metadata: a title and a description in the page's language, and never
 * indexed (a form, not a page to find: the landing and the service pages are).
 */
export async function requestMetadata(locale: Locale): Promise<Metadata> {
  const t = await getT(locale);
  return {
    title: t("request.meta.title"),
    description: t("request.meta.description"),
    robots: { index: false, follow: false },
  };
}
