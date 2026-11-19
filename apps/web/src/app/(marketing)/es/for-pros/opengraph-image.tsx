import { landingOgImage, OG_SIZE, ogAlt } from "@/features/landing/og-image";
import catalog from "@/i18n/locales/es.json";

export const alt = ogAlt("es", "forPros");
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OpenGraphImage() {
  return landingOgImage("es", catalog.forPros.meta.ogLine);
}
