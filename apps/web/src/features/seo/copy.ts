import type { TFunction } from "i18next";

import { isShippedSlug } from "@/features/landing/categories";

/**
 * A service's one-line description: the landing's line for a category the product ships, the
 * landing's general line for one added later (until it has its own copy).
 */
export function serviceLine(t: TFunction, slug: string): string {
  return isShippedSlug(slug) ? t(`landing.services.lines.${slug}`) : t("landing.services.other");
}
