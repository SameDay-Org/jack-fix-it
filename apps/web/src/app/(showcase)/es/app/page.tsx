import type { Metadata } from "next";

import { showcaseMetadata } from "@/features/showcase/metadata";
import { ShowcasePage } from "@/features/showcase/showcase-page";

export function generateMetadata(): Promise<Metadata> {
  return showcaseMetadata("es");
}

export default function Page() {
  return <ShowcasePage locale="es" />;
}
