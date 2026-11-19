import type { Metadata } from "next";

import { requestMetadata } from "@/features/request-flow/metadata";
import { RequestPage, type RequestSearch } from "@/features/request-flow/request-page";

export function generateMetadata(): Promise<Metadata> {
  return requestMetadata("en");
}

export default async function Page({ searchParams }: { searchParams: Promise<RequestSearch> }) {
  return <RequestPage locale="en" search={await searchParams} />;
}
