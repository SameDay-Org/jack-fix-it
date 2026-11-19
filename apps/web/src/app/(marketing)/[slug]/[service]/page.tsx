import type { Metadata } from "next";

import { serviceMetadata } from "@/features/seo/metadata";
import { ServicePage } from "@/features/seo/service-page";

/** `/<city>/<service>`: the first segment is a served city's slug. */
type Props = { params: Promise<{ slug: string; service: string }> };

// Kept an hour, as the catalog read (catalog.ts: CATALOG_REVALIDATE_SECONDS; a literal: Next
// reads it before running any code).
export const revalidate = 3600;

/**
 * None at build time: the API is not reachable while the site is built. Each city's page is made
 * on its first visit and kept for an hour; a city or service without a page is a 404.
 */
export function generateStaticParams(): { slug: string; service: string }[] {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, service } = await params;
  return serviceMetadata("en", service, slug);
}

export default async function Page({ params }: Props) {
  const { slug, service } = await params;
  return <ServicePage locale="en" slug={service} city={slug} />;
}
