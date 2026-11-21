import type { Metadata } from "next";

import { serviceMetadata } from "@/features/seo/metadata";
import { ServicePage } from "@/features/seo/service-page";

type Props = { params: Promise<{ slug: string }> };

// Kept an hour, as the landing (catalog.ts: CATALOG_REVALIDATE_SECONDS; a literal: Next reads it
// before running any code).
export const revalidate = 3600;

/**
 * None at build time: the API is not reachable while the site is built. Each service's page is
 * made on its first visit and kept for an hour; an inactive or unknown slug is a 404.
 */
export function generateStaticParams(): { slug: string }[] {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return serviceMetadata("es", (await params).slug);
}

export default async function Page({ params }: Props) {
  return <ServicePage locale="es" slug={(await params).slug} />;
}
