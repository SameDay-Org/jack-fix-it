import type { Metadata } from "next";

import { LandingPage } from "@/features/landing/landing-page";
import { landingMetadata } from "@/features/landing/metadata";

// Built once, refreshed every hour: the services grid reads the categories from the API at most
// once an hour for all visitors (a literal: Next reads it before running any code).
export const revalidate = 3600;

export function generateMetadata(): Promise<Metadata> {
  return landingMetadata("en");
}

export default function Page() {
  return <LandingPage locale="en" />;
}
