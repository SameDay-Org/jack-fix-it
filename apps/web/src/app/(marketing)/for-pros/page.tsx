import type { Metadata } from "next";

import { ForProsPage } from "@/features/for-pros/for-pros-page";
import { forProsMetadata } from "@/features/for-pros/metadata";

export function generateMetadata(): Promise<Metadata> {
  return forProsMetadata("en");
}

export default function Page() {
  return <ForProsPage locale="en" />;
}
