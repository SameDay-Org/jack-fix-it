import { landingOgImage, OG_SIZE, ogAlt } from "@/features/landing/og-image";
import catalog from "@/i18n/locales/es.json";

// The landing's card with the showcase's own line (#461).
export const alt = ogAlt("es", "showcase");
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OpenGraphImage() {
  return landingOgImage("es", catalog.showcase.hero.lead);
}
