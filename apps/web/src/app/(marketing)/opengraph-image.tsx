import { landingOgImage, OG_SIZE, ogAlt } from "@/features/landing/og-image";

export const alt = ogAlt("en");
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OpenGraphImage() {
  return landingOgImage("en");
}
