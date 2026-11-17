import type { Metadata } from "next";

import { showcaseMetadata } from "@/features/showcase/metadata";
import { ShowcasePage } from "@/features/showcase/showcase-page";

export function generateMetadata(): Promise<Metadata> {
  return showcaseMetadata("en");
}

export default function Page() {
  return <ShowcasePage locale="en" />;
}
