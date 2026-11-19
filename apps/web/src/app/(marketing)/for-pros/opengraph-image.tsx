import { landingOgImage, OG_SIZE, ogAlt } from "@/features/landing/og-image";
import catalog from "@/i18n/locales/en.json";

export const alt = ogAlt("en", "forPros");
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OpenGraphImage() {
  return landingOgImage("en", catalog.forPros.meta.ogLine);
}
