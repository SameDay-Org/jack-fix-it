import { OG_SIZE } from "@/features/landing/og-image";
import { serviceOgImage } from "@/features/seo/metadata";
import catalog from "@/i18n/locales/es.json";

export const alt = catalog.seo.service.meta.ogAlt;
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function OpenGraphImage({
  params,
}: {
  params: Promise<{ slug: string; service: string }>;
}) {
  const { slug, service } = await params;
  return serviceOgImage("es", service, slug);
}
