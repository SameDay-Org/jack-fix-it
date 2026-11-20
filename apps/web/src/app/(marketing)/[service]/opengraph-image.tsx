import { OG_SIZE } from "@/features/landing/og-image";
import { serviceOgImage } from "@/features/seo/metadata";
import catalog from "@/i18n/locales/en.json";

export const alt = catalog.seo.service.meta.ogAlt;
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function OpenGraphImage({ params }: { params: Promise<{ service: string }> }) {
  return serviceOgImage("en", (await params).service);
}
