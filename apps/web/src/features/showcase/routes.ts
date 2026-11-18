import type { Locale } from "@/i18n/config";

/** The showcase page, in each language. English has no prefix; Spanish lives under `/es`. */
export const SHOWCASE_PATHS: Record<Locale, string> = { en: "/app", es: "/es/app" };

/** The page's anchors: the header, the hero and the footer link to them. */
export const ANCHORS = {
  top: "top",
  how: "how",
  pros: "pros",
  soon: "soon",
  faq: "faq",
} as const;
