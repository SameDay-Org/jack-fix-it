import { landingOgImage, OG_SIZE, ogAlt } from "@/features/landing/og-image";
import catalog from "@/i18n/locales/en.json";

// The landing's card with the showcase's own line (#461).
export const alt = ogAlt("en", "showcase");
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OpenGraphImage() {
  return landingOgImage("en", catalog.showcase.hero.lead);
}
