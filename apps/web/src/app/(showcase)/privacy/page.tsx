import type { Metadata } from "next";

import { LegalPlaceholder } from "@/features/showcase/legal-placeholder";
import { legalMetadata } from "@/features/showcase/metadata";

export function generateMetadata(): Promise<Metadata> {
  return legalMetadata("en", "privacy");
}

export default function Page() {
  return <LegalPlaceholder locale="en" document="privacy" />;
}
